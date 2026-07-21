const express = require('express');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 9876;

// --- Middleware ---
app.use(express.json());
app.use(express.text({ type: 'text/plain' }));
app.use(express.text({ type: 'application/sdp' }));

// Serve static files from deviceMgr (official native files)
app.use(express.static(path.join(__dirname, './deviceMgr')));

// --- WebRTC SDP Proxy ---
// Proxies SDP offer to the printer's go2rtc endpoint to bypass CORS.
// Creality K2 Pro uses a proprietary protocol:
//   Request:  Base64(JSON({type:"offer", sdp:"..."})) with Content-Type: plain/text
//   Response: Base64(JSON({type:"answer", sdp:"..."}))
app.post('/api/webrtc/sdp', async (req, res) => {
    const { printerIp, videoPort, sdp, endpoint } = req.body;

    if (!printerIp || !sdp) {
        return res.status(400).json({ error: 'Missing printerIp or sdp' });
    }

    const port = videoPort || 8000;
    const ep = endpoint || '/call/webrtc_local';
    const targetUrl = `http://${printerIp}:${port}${ep}`;
    const triedUrls = [];
    const errors = [];

    // --- SDP mDNS Unmasking Hack ---
    // Chrome hides local LAN IPs using mDNS (e.g. xxxx.local) for security.
    // The printer cannot resolve .local hostnames, so DTLS fails because the printer
    // doesn't know where to send packets. We rewrite the offer SDP to use the host PC's real LAN IP.
    const hostLocalIp = getLocalIp(printerIp);
    const unmaskedSdp = rewriteOfferSdp(sdp, hostLocalIp);
    console.log(`[SDP Proxy] Host Local IP: ${hostLocalIp}`);

    // ── Strategy 1: Creality format (Base64-encoded JSON offer/answer) ──
    // This is the correct protocol for K2 Pro and K1 series printers.
    // See: go2rtc client_creality.go — offerToB64 / answerFromB64
    try {
        console.log(`[SDP Proxy] Strategy 1: Creality Base64 JSON to ${targetUrl}`);
        triedUrls.push(targetUrl);

        // Wrap the unmasked SDP in JSON and Base64-encode
        const offerJson = JSON.stringify({ type: 'offer', sdp: unmaskedSdp });
        const offerB64 = Buffer.from(offerJson).toString('base64');
        console.log(`[SDP Proxy] Offer JSON length: ${offerJson.length}, Base64 length: ${offerB64.length}`);

        const rawAnswer = await httpPost(targetUrl, offerB64, {
            'Content-Type': 'plain/text',
        });

        console.log(`[SDP Proxy] Response length: ${rawAnswer.length}`);
        console.log(`[SDP Proxy] Response (first 200 chars): ${rawAnswer.substring(0, 200)}`);

        // Try to Base64-decode the response
        const parsed = tryParseSdpAnswer(rawAnswer);
        if (parsed) {
            console.log(`[SDP Proxy] ✅ Strategy 1 success (format: ${parsed.format})`);
            return res.json({ type: 'answer', sdp: parsed.sdp, format: parsed.format });
        }
        errors.push(`Strategy 1: Got response but could not extract SDP`);
    } catch (err) {
        console.error(`[SDP Proxy] Strategy 1 failed:`, err.message);
        errors.push(`Strategy 1 (${targetUrl}): ${err.message}`);
    }

    // ── Strategy 2: WHIP-style POST (application/sdp → raw SDP answer) ──
    try {
        console.log(`[SDP Proxy] Strategy 2: WHIP POST application/sdp to ${targetUrl}`);
        const rawAnswer = await httpPost(targetUrl, sdp, {
            'Content-Type': 'application/sdp',
        });

        console.log(`[SDP Proxy] Response (first 200 chars): ${rawAnswer.substring(0, 200)}`);

        const parsed = tryParseSdpAnswer(rawAnswer);
        if (parsed) {
            console.log(`[SDP Proxy] ✅ Strategy 2 success (format: ${parsed.format})`);
            return res.json({ type: 'answer', sdp: parsed.sdp, format: parsed.format });
        }
        errors.push(`Strategy 2: Got response but could not extract SDP`);
    } catch (err) {
        console.error(`[SDP Proxy] Strategy 2 failed:`, err.message);
        errors.push(`Strategy 2 (${targetUrl}): ${err.message}`);
    }

    // ── Strategy 3: go2rtc JSON API (plain JSON, no Base64) ──
    const jsonUrl = `http://${printerIp}:${port}/api/webrtc?src=webrtc_local`;
    try {
        console.log(`[SDP Proxy] Strategy 3: go2rtc JSON API ${jsonUrl}`);
        triedUrls.push(jsonUrl);
        const jsonAnswer = await httpPost(jsonUrl, JSON.stringify({ type: 'offer', sdp }), {
            'Content-Type': 'application/json',
        });

        console.log(`[SDP Proxy] Response (first 200 chars): ${jsonAnswer.substring(0, 200)}`);

        const parsed = tryParseSdpAnswer(jsonAnswer);
        if (parsed) {
            console.log(`[SDP Proxy] ✅ Strategy 3 success (format: ${parsed.format})`);
            return res.json({ type: 'answer', sdp: parsed.sdp, format: parsed.format });
        }
        errors.push(`Strategy 3: Got response but could not extract SDP`);
    } catch (err) {
        console.error(`[SDP Proxy] Strategy 3 failed:`, err.message);
        errors.push(`Strategy 3 (${jsonUrl}): ${err.message}`);
    }

    // All strategies failed
    console.error(`[SDP Proxy] ❌ All strategies failed`);
    res.status(502).json({
        error: 'Failed to negotiate SDP with printer',
        triedUrls,
        errors,
    });
});

/**
 * Try to extract a valid SDP answer from various response formats:
 *  1. Raw SDP (starts with "v=0")
 *  2. Base64-encoded JSON {type:"answer", sdp:"v=0..."}  (Creality format)
 *  3. Plain JSON {type:"answer", sdp:"v=0..."}
 *  4. Base64-encoded raw SDP
 * Returns { sdp, format } or null.
 */
function tryParseSdpAnswer(raw) {
    if (!raw || !raw.trim()) return null;
    const trimmed = raw.trim();

    // 1. Raw SDP
    if (trimmed.startsWith('v=')) {
        return { sdp: trimmed, format: 'raw_sdp' };
    }

    // 2. Plain JSON
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (obj.sdp && obj.sdp.startsWith('v=')) {
                return { sdp: obj.sdp, format: 'json' };
            }
        } catch (e) { /* not valid JSON */ }
    }

    // 3. Base64-encoded (could be JSON or raw SDP)
    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        // 3a. Base64 → Raw SDP
        if (decoded.startsWith('v=')) {
            return { sdp: decoded, format: 'base64_sdp' };
        }
        // 3b. Base64 → JSON
        if (decoded.startsWith('{')) {
            const obj = JSON.parse(decoded);
            if (obj.sdp && obj.sdp.startsWith('v=')) {
                return { sdp: obj.sdp, format: 'base64_json' };
            }
        }
    } catch (e) { /* not valid base64 */ }

    console.warn(`[SDP Proxy] Could not parse response as SDP. First 100 chars: ${trimmed.substring(0, 100)}`);
    return null;
}

// --- Generic Printer API Proxy ---
// Proxies any request to the printer's Moonraker/HTTP API (for future use).
app.all('/api/printer/:ip/:port/*', async (req, res) => {
    const { ip, port } = req.params;
    const restPath = req.params[0] || '';
    const targetUrl = `http://${ip}:${port}/${restPath}`;

    try {
        if (req.method === 'GET') {
            const data = await httpGet(targetUrl);
            try {
                res.json(JSON.parse(data));
            } catch {
                res.send(data);
            }
        } else {
            const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            const data = await httpPost(targetUrl, body, {
                'Content-Type': req.get('Content-Type') || 'application/json',
            });
            try {
                res.json(JSON.parse(data));
            } catch {
                res.send(data);
            }
        }
    } catch (err) {
        res.status(502).json({ error: 'Proxy request failed', detail: err.message });
    }
});

// --- Helper Functions ---

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 10000,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(body);
        req.end();
    });
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: 10000,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

function getLocalIp(printerIp) {
    const interfaces = os.networkInterfaces();
    let fallbackIp = null;

    const printerSubnet = printerIp.split('.').slice(0, 3).join('.');

    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                if (net.address.startsWith(printerSubnet)) {
                    return net.address;
                }
                fallbackIp = net.address;
            }
        }
    }
    return fallbackIp || '127.0.0.1';
}

function rewriteOfferSdp(sdp, localIp) {
    if (!localIp || localIp === '127.0.0.1') return sdp;

    return sdp.split(/\r?\n/).map(line => {
        // 1. Rewrite WebRTC candidate lines
        if (line.startsWith('a=candidate:')) {
            const parts = line.split(' ');
            if (parts.length >= 8) {
                const ipOrDomain = parts[4];
                // Replace masked mDNS domains ending in .local, loopback, or invalid addresses
                if (ipOrDomain.endsWith('.local') || ipOrDomain === '127.0.0.1' || ipOrDomain === 'localhost' || ipOrDomain === '0.0.0.0') {
                    console.log(`[SDP Rewrite] Unmasking candidate: '${ipOrDomain}' -> '${localIp}'`);
                    parts[4] = localIp;
                    return parts.join(' ');
                }
            }
        }
        // 2. Rewrite main connection line
        if (line.startsWith('c=IN IP4 ')) {
            const ip = line.substring(9).trim();
            if (ip === '127.0.0.1' || ip === '0.0.0.0') {
                console.log(`[SDP Rewrite] Rewriting connection address: '${ip}' -> '${localIp}'`);
                return `c=IN IP4 ${localIp}`;
            }
        }
        return line;
    }).join('\r\n');
}

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  Creality Device Proxy Server                    ║`);
    console.log(`║  Running on http://localhost:${PORT}               ║`);
    console.log(`║                                                  ║`);
    console.log(`║  For Orca Slicer, set Device UI URL to:          ║`);
    console.log(`║  http://localhost:${PORT}                          ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
});
