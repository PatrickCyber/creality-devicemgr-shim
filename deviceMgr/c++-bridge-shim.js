/**
 * Creality Print WebView C++ Bridge Shim for standalone browser environments.
 * Intercepts window.wx.postMessage commands and mocks C++ native callbacks.
 */
(function () {
    'use strict';

    //console.log('[C++ Shim] Initializing Creality C++ Webview Bridge Shim...');

    // Monkey-patch URLSearchParams to avoid official Creality JS crashes on missing parameters
    const originalGet = URLSearchParams.prototype.get;
    URLSearchParams.prototype.get = function (name) {
        if (name === 'os') {
            return originalGet.call(this, name) || 'windows';
        }
        if (name === 'port') {
            return originalGet.call(this, name) || '9876';
        }
        return originalGet.call(this, name);
    };

    // Dynamically inject CSS to hide the Creality Cloud binds / login view notice at the bottom
    // The LoginView component is identified by the scoped attribute [data-v-bd8b6f81]
    const style = document.createElement('style');
    style.textContent = `
        div[data-v-bd8b6f81] {
            display: none !important;
        }
    `;
    document.head.appendChild(style);

    // Map browser UI languages to official i18n keys
    const browserLang = (navigator.language || navigator.userLanguage || 'zh-CN').toLowerCase();
    let finalLang = 'en_GB';

    if (browserLang.startsWith('zh-tw') || browserLang.startsWith('zh-hk')) {
        finalLang = 'zh_TW';
    } else if (browserLang.startsWith('zh')) {
        finalLang = 'zh_CN';
    } else if (browserLang.startsWith('de')) {
        finalLang = 'de_DE';
    } else if (browserLang.startsWith('es')) {
        finalLang = 'es_ES';
    } else if (browserLang.startsWith('fr')) {
        finalLang = 'fr_FR';
    } else if (browserLang.startsWith('it')) {
        finalLang = 'it_IT';
    } else if (browserLang.startsWith('ja')) {
        finalLang = 'ja_JP';
    } else if (browserLang.startsWith('ko')) {
        finalLang = 'ko_KR';
    } else {
        finalLang = 'en_GB';
    }

    // Allow manual language override via query parameter (e.g. ?ip=...&lang=zh_CN)
    const urlParams = new URLSearchParams(window.location.search);
    const ip = urlParams.get('ip') || urlParams.get('printerIp');
    const mac = urlParams.get('mac') || 'XXXXXXXXXXXX';
    const model = urlParams.get('model') || 'K2 Pro';
    const page = urlParams.get('page') || 'detail';
    const queryLang = urlParams.get('lang') || urlParams.get('locale');
    if (queryLang) {
        finalLang = queryLang;
    }

    //console.log(`[C++ Shim] Configured IP: ${ip}, Model: ${model}, Lang Key: ${finalLang} (raw: ${browserLang})`);

    // Define wx bridge object if not injected
    if (!window.wx) {
        window.wx = {};
    }

    // Helper to call native JS method handleStudioCmd
    function sendStudioCmd(data) {
        //console.log('[C++ Shim] Sending command to Vue:', data.command, data);
        if (typeof window.handleStudioCmd === 'function') {
            window.handleStudioCmd(data);
        } else {
            if (!Array.isArray(window.__studioCmdQueue__)) {
                window.__studioCmdQueue__ = [];
            }
            window.__studioCmdQueue__.push(data);
        }
    }

    // Intercept outgoing postMessage calls
    window.wx.postMessage = function (msgStr) {
        //console.log('[C++ Shim] Outgoing message to C++:', msgStr);
        try {
            const msg = JSON.parse(msgStr);
            handlePostMessage(msg);
        } catch (e) {
            console.error('[C++ Shim] Failed to parse outgoing JSON payload:', e);
        }
    };

    // Main router for intercepted postMessage commands
    function handlePostMessage(msg) {
        const cmd = msg.command;

        if (cmd === 'get_machine_list') {
            // Reply with minimal printer model presets list (K2 Pro, K1, K1 Max)
            const presets = [
                {
                    printerIntName: "K2 Pro",
                    name: "Creality K2 Pro",
                    nozzleDiameter: [0.4],
                    type: 3
                },
                {
                    printerIntName: "K1",
                    name: "Creality K1",
                    nozzleDiameter: [0.4],
                    type: 3
                },
                {
                    printerIntName: "K1 Max",
                    name: "Creality K1 Max",
                    nozzleDiameter: [0.4],
                    type: 3
                }
            ];
            setTimeout(() => {
                sendStudioCmd({
                    command: "get_machine_list",
                    data: presets
                });
            }, 50);
        }
        else if (cmd === 'init_device') {
            // Reply with single printer group schema if IP is specified
            const groupsList = [];
            if (ip) {
                groupsList.push({
                    group: "默认分组",
                    type: 0,
                    visable: true,
                    list: [
                        {
                            connectType: 3,
                            model: model,
                            mac: mac,
                            name: model,
                            address: ip,
                            online: true,
                            features: ["videoInfo.videoEncryption"] // Forces C++ WebRTC handler path
                        }
                    ]
                });
            }

            const printerData = {
                current_device: {
                    mac: ip ? mac : ""
                },
                groups: groupsList
            };

            setTimeout(() => {
                sendStudioCmd({
                    command: "init_device",
                    data: printerData
                });

                // Auto-route directly to the device details page if IP is specified and target page is not 'list'
                if (ip && page !== 'list') {
                    setTimeout(() => {
                        //console.log('[C++ Shim] Auto-routing to device details page for:', model, ip);
                        sendStudioCmd({
                            command: "forward_device_detail",
                            ip: ip,
                            name: model
                        });
                    }, 300);
                }
            }, 50);
        }
        else if (cmd === 'get_user') {
            // By returning empty strings for userId and token, we tell the Vue app
            // that the user is logged out. This triggers the native code's removeGroup("") method,
            // which automatically removes the empty group ("Creality Cloud binds devices") and bypasses IoT cloud sync.
            setTimeout(() => {
                sendStudioCmd({
                    command: "get_user",
                    data: {
                        userId: "",
                        token: "",
                        region: "China",
                        pid: ""
                    }
                });
            }, 20);
        }
        else if (cmd === 'get_system_id') {
            setTimeout(() => {
                sendStudioCmd({
                    command: "get_system_id",
                    data: "local_system_id_mock"
                });
            }, 20);
        }
        else if (cmd === 'get_lang') {
            // Intercept get_lang query from Vue app and reply with the auto-detected language key
            setTimeout(() => {
                sendStudioCmd({
                    command: "get_lang",
                    data: finalLang
                });
            }, 20);
        }
        else if (cmd === 'is_dark_theme') {
            // Intercept is_dark_theme query from Vue app and reply with dark theme state
            setTimeout(() => {
                sendStudioCmd({
                    command: "is_dark_theme",
                    data: true
                });
            }, 20);
        }
        else if (cmd === 'req_device_move_direction') {
            setTimeout(() => {
                sendStudioCmd({
                    command: "req_device_move_direction",
                    data: {
                        address: ip || "",
                        direction: "xyz",
                        machine_LED_light_exist: 1,
                        auxiliary_fan: 1,
                        support_air_filtration: 1,
                        machine_ptc_exist: 1
                    }
                });
            }, 20);
        }
        else if (cmd === 'get_webrtc_local_param') {
            const sdpOffer = msg.sdp;
            const endpointUrl = msg.url;
            
            let port = 8000;
            try {
                const parsedUrl = new URL(endpointUrl);
                port = parseInt(parsedUrl.port) || 8000;
            } catch(e) {}

            //console.log(`[C++ Shim] Intercepted SDP offer for WebRTC. Exchanging via proxy server...`);
            
            // HTTP POST directly to our Express server's SDP proxy endpoint
            fetch('/api/webrtc/sdp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    printerIp: ip,
                    videoPort: port,
                    sdp: sdpOffer,
                    endpoint: '/call/webrtc_local'
                })
            })
            .then(res => {
                if (!res.ok) throw new Error('SDP Proxy returned HTTP status ' + res.status);
                return res.json();
            })
            .then(data => {
                if (data && data.sdp) {
                    //console.log('[C++ Shim] SDP Answer received from proxy');
                    // Base64 encode the response JSON as expected by Vue
                    const answerPayload = {
                        type: "answer",
                        sdp: data.sdp
                    };
                    const answerB64 = btoa(unescape(encodeURIComponent(JSON.stringify(answerPayload))));
                    
                    sendStudioCmd({
                        command: "get_webrtc_local_param",
                        url: endpointUrl,
                        sdp: answerB64
                    });
                } else {
                    console.error('[C++ Shim] SDP Proxy response did not contain answer SDP');
                }
            })
            .catch(err => {
                console.error('[C++ Shim] SDP Proxy exchange failed:', err);
            });
        }
        else if (cmd === 'common_openurl') {
            if (msg.url) {
                window.open(msg.url, '_blank');
            }
        }
    }

    // Set configuration variables on startup (safe queue fallback)
    sendStudioCmd({
        command: "get_lang",
        data: finalLang
    });

    sendStudioCmd({
        command: "is_dark_theme",
        data: true
    });

    // Start a periodic heartbeat emitter to tell Vue to maintain connections if IP is available
    if (ip) {
        setInterval(() => {
            sendStudioCmd({
                command: "start_heartbeat_cmd",
                data: JSON.stringify({ address: ip })
            });
        }, 2000);
    }

})();
