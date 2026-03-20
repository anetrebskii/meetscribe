"use strict";

/**
 * Tactiq Google Meet Integration
 * This script provides RTC data channel interception and message processing
 * for Google Meet to capture transcription and chat data.
 */

(function() {
    // Import protobuf for message decoding
    const protobuf = require('protobufjs');
    
    // Language code mappings for Google Meet
    const LANGUAGE_CODES = {
        1: "en-US", 2: "es-MX", 3: "es-ES", 4: "pt-BR", 5: "fr-FR",
        6: "de-DE", 7: "it-IT", 8: "nl-NL", 9: "ja-JP", 10: "ru-RU",
        11: "ko-KR", 17: "pt-PT", 18: "hi-IN", 19: "en-IN", 20: "en-GB",
        21: "en-CA", 22: "en-AU", 23: "nl-BE", 24: "sv-SE", 25: "nb-NO",
        34: "cmn-Hans-CN", 35: "cmn-Hant-TW", 37: "th-TH", 38: "tr-TR",
        39: "pl-PL", 40: "ro-RO", 41: "id-ID", 42: "vi-VN", 43: "ms-MY",
        44: "uk-UA", 47: "ar-EG", 73: "fr-CA", 74: "xh-ZA", 75: "nso-ZA",
        76: "st-ZA", 77: "ss-latn-ZA", 79: "tn-latn-ZA", 80: "ts-ZA",
        81: "bg-BG", 82: "km-KH", 83: "rw-RW", 84: "ar-AE", 85: "ar-x-LEVANT",
        86: "ar-x-MAGHREBI", 87: "bn-BD", 88: "gu-IN", 89: "kn-IN", 90: "ml-IN",
        93: "cs-CZ", 94: "da-DK", 95: "fi-FI", 96: "lo-LA", 97: "sw",
        98: "af-ZA", 99: "am-ET", 100: "az-AZ", 101: "el-GR", 102: "en-PH",
        103: "eu-ES", 104: "fa-IR", 105: "he-IL", 106: "hu-HU", 108: "jv-ID",
        109: "mn-MN", 112: "sk-SK", 113: "sq-AL", 114: "ta-IN", 115: "te-IN",
        116: "ur-PK", 117: "uz-UZ", 118: "zu-ZA", 119: "et-EE", 120: "fil-PH",
        121: "is-IS", 122: "ka-GE", 123: "su-ID", 125: "mk-MK", 126: "my-MM",
        127: "ne-NP", 128: "si-LK", 129: "ca-ES", 130: "gl-ES", 131: "lt-LT",
        132: "lv-LV", 133: "sl-SI", 134: "sr-RS", 137: "hy-AM", 191: "kk-KZ"
    };

    // Google Meet API endpoints
    const API_ENDPOINTS = {
        modify: "https://meet.google.com/hangouts/v1_meetings/media_sessions/modify",
        queryCaptionLanguage: "https://meet.google.com/hangouts/v1_meetings/media_sessions/query",
        syncMeetingSpaceCollections: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections",
        createMeetingMessage: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingMessageService/CreateMeetingMessage",
        createMeetingRecording: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingRecordingService/CreateMeetingRecording",
        getMediaSession: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/GetMediaSession",
        updateMediaSession: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/UpdateMediaSession",
        createMeetingDevice: "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingDeviceService/CreateMeetingDevice"
    };

    // Global state
    let currentMediaSessionId = null;
    let requestHeaders = {};
    let debugMode = false;
    let messageQueue = [];
    let messageCounter = 50000;

    /**
     * Logger utility for debugging
     */
    const Logger = {
        debug: (message, data) => {
            if (debugMode || !isProduction()) {
                console.log(`[TACTIQ] ${message}`, data || '');
            }
        },
        info: (message, data) => {
            console.info(`[TACTIQ] ${message}`, data || '');
        },
        warn: (message, data) => {
            console.warn(`[TACTIQ] ${message}`, data || '');
        },
        error: (message, data) => {
            console.error(`[TACTIQ] ${message}`, data || '');
        }
    };

    /**
     * Check if running in production
     */
    function isProduction() {
        return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    }

    /**
     * Dispatch custom event to communicate with content script
     */
    function dispatchTactiqMessage(message) {
        document.documentElement.dispatchEvent(
            new window.CustomEvent('tactiq-message', { detail: message })
        );
    }

    /**
     * Get Google Meet version from global data
     */
    function getGoogleMeetVersion() {
        try {
            const globalData = window.WIZ_global_data ?? {};
            const versionString = Object.values(globalData)
                .filter(val => typeof val === 'string')
                .find(val => val.startsWith('boq_meetingsuiserver_')) ?? '';
            return versionString.split('boq_meetingsuiserver_')[1] || 'unknown_err';
        } catch {
            return 'unknown_err';
        }
    }

    /**
     * Decompress data if it's gzipped
     */
    function decompressData(data) {
        const uint8Array = new Uint8Array(data);
        
        // Check if data is gzipped (magic numbers: 1f 8b 08)
        const isGzipped = uint8Array.length >= 3 && 
            uint8Array[0] === 31 && uint8Array[1] === 139 && uint8Array[2] === 8;
        
        if (isGzipped) {
            return pako.inflate(uint8Array);
        }
        
        // Check if data is gzipped starting from offset 3
        const isGzippedOffset = uint8Array.length >= 6 &&
            uint8Array[3] === 31 && uint8Array[4] === 139 && uint8Array[5] === 8;
        
        if (isGzippedOffset) {
            return pako.inflate(uint8Array.slice(3));
        }
        
        return uint8Array;
    }

    /**
     * Process transcript message from binary data
     */
    function processTranscriptMessage(data) {
        try {
            const uint8Array = new Uint8Array(data.buffer);
            
            // Try protobuf decoding first
            const protobufResult = decodeTranscriptProtobuf(uint8Array);
            if (protobufResult?.message) {
                return protobufResult.message;
            }

            // Fallback to manual parsing
            return parseTranscriptManually(data);
        } catch (error) {
            Logger.debug('Failed to process transcript message', error);
            return null;
        }
    }

    /**
     * Decode transcript message using protobuf
     */
    function decodeTranscriptProtobuf(data) {
        try {
            const wrapper = TactiqGoogleMeet.BTranscriptMessageWrapper.decode(data);
            if (wrapper.unknown2) return {};
            
            const message = wrapper.message;
            if (!message || !message.deviceId || !message.messageId || 
                !message.messageVersion || !message.langId) {
                return null;
            }

            return {
                message: {
                    deviceId: `@${message.deviceId}`,
                    messageId: `${message.messageId}/@${message.deviceId}`,
                    messageVersion: typeof message.messageVersion === 'number' ? 
                        message.messageVersion : message.messageVersion.low,
                    langId: typeof message.langId === 'number' ? 
                        message.langId : message.langId.low,
                    text: message.text || ''
                }
            };
        } catch {
            return null;
        }
    }

    /**
     * Parse transcript message manually (fallback)
     */
    function parseTranscriptManually(data) {
        if (debugMode) {
            dispatchTactiqMessage({
                type: 'debug',
                data: Array.from(data).join(', ')
            });
        }

        const messageIdIndex = data.indexOf(16) + 1;
        const boundaryPatterns = [
            [24, 0, 32, 1, 45, 0],
            [24, 0, 1, 32, 1, 45, 0],
            [24, 0, 45, 0],
            [24, 0, 1, 45, 0]
        ];

        let boundaryIndex = -1;
        for (const pattern of boundaryPatterns) {
            const index = findPattern(data, pattern, messageIdIndex, 1);
            if (index > -1) {
                boundaryIndex = index;
                break;
            }
        }

        if (boundaryIndex === -1) {
            // Try alternative patterns
            const altPatterns = [
                [24, 0, 32, 1, 50],
                [24, 0, 1, 32, 1, 50],
                [24, 0, 50],
                [24, 0, 1, 50]
            ];

            for (const pattern of altPatterns) {
                const result = findPatternWithLength(data, pattern, messageIdIndex, 1);
                if (result) {
                    boundaryIndex = result.index;
                    break;
                }
            }
        }

        if (boundaryIndex === -1) return null;

        // Extract message components
        const messageIdData = data.slice(messageIdIndex, boundaryIndex);
        let messageId = 0;
        for (let i = 0; i < messageIdData.length; i++) {
            messageId += messageIdData[i] * Math.pow(256, i);
        }

        // Extract text and metadata
        const textData = data.slice(findPattern(data, [128, 63]) + 4);
        const langIndex = findPattern(textData, [64, 0, 72], 0, 1);
        if (langIndex === -1) return null;

        const langId = textData[langIndex + 1];
        const textBytes = textData.slice(0, langIndex);
        const deviceId = new TextDecoder().decode(data.slice(3, data.indexOf(16, 4))).trim();
        const text = new TextDecoder().decode(textBytes);

        const result = {
            deviceId,
            messageId: `${messageId}/${deviceId}`,
            messageVersion: data[boundaryIndex + 1],
            langId,
            text
        };

        return result.deviceId && result.text ? result : null;
    }

    /**
     * Process chat message from binary data
     */
    function processChatMessage(data, skipDebug = false) {
        try {
            // Try protobuf decoding first
            const protobufResult = decodeChatProtobuf(new Uint8Array(data.buffer));
            if (protobufResult) return protobufResult;

            // Fallback to manual parsing
            return parseChatManually(data, skipDebug);
        } catch (error) {
            if (!skipDebug) {
                Logger.debug('Failed to process chat message', error);
            }
            return null;
        }
    }

    /**
     * Decode chat message using protobuf
     */
    function decodeChatProtobuf(data) {
        try {
            const wrapper = TactiqGoogleMeet.BChatMessageWrapper.decode(data);
            const message = wrapper.l1?.l2?.l3?.l4?.message;
            
            if (!message) return null;

            return {
                type: 'chat',
                deviceId: `@${message.deviceId}`,
                messageId: `${message.timestamp}/@${message.deviceId}`,
                messageVersion: 0,
                text: message.text?.value || ''
            };
        } catch {
            return null;
        }
    }

    /**
     * Parse chat message manually (fallback)
     */
    function parseChatManually(data, skipDebug) {
        if (debugMode && !skipDebug) {
            dispatchTactiqMessage({
                type: 'debug',
                data: Array.from(data).join(', ')
            });
        }

        const messagePattern = [47, 109, 101, 115, 115, 97, 103, 101, 115, 47]; // "/messages/"
        const messageIndex = findPattern(data, messagePattern);
        if (messageIndex === -1) return null;

        const deviceIdStartIndex = findPattern(data, [18], messageIndex);
        if (deviceIdStartIndex === -1) return null;

        const messageId = new TextDecoder().decode(
            data.slice(messageIndex + messagePattern.length, deviceIdStartIndex)
        );

        const deviceIdLength = deviceIdStartIndex + 1;
        const textStartIndex = findPattern(data, [24], deviceIdLength);
        const deviceId = new TextDecoder().decode(data.slice(deviceIdLength, textStartIndex));

        const textLengthIndex = findPattern(data, [10], deviceIdLength) + 1;
        if (textLengthIndex === 0) return null;

        // Handle text length encoding
        let textStart = textLengthIndex;
        if (data[textLengthIndex - 1] === 10 && data[textLengthIndex + 1] === 8) {
            textStart++;
        }

        const lengthBytes = data.slice(textLengthIndex, textStart);
        let textLength = 0;
        for (let i = 0; i < lengthBytes.length; i++) {
            textLength += Math.pow(128, i) * (i ? lengthBytes[i] - 1 : lengthBytes[i]);
        }

        const textEnd = textStart + textLength;
        const text = new TextDecoder().decode(data.slice(textStart, textEnd));

        return {
            type: 'chat',
            deviceId,
            messageId: `${messageId}/${deviceId}`,
            messageVersion: 0,
            text
        };
    }

    /**
     * Process device information from binary data
     */
    function processDeviceInfo(data) {
        try {
            const protobufResult = decodeDeviceProtobuf(new Uint8Array(data.buffer));
            return protobufResult || null;
        } catch {
            return null;
        }
    }

    /**
     * Decode device info using protobuf
     */
    function decodeDeviceProtobuf(data) {
        try {
            const device = TactiqGoogleMeet.BDevice.decode(data);
            const deviceInfo = device.l1?.l2?.l3?.l4?.l5;
            
            if (!deviceInfo || !deviceInfo.deviceId || !deviceInfo.deviceName) {
                return null;
            }

            return {
                deviceId: `@${deviceInfo.deviceId}`,
                deviceName: deviceInfo.deviceName
            };
        } catch {
            return null;
        }
    }

    /**
     * Process meeting collection (list of devices)
     */
    function processMeetingCollection(data) {
        try {
            const collection = TactiqGoogleMeet.BMeetingCollection.decode(new Uint8Array(data.buffer));
            const devices = collection.l1?.l2?.l3;
            
            if (!devices || !devices.length) return null;

            return devices
                .filter(device => device.deviceId && device.deviceName)
                .map(device => ({
                    deviceId: `@${device.deviceId}`,
                    deviceName: device.deviceName ?? ''
                }));
        } catch {
            return null;
        }
    }

    /**
     * Create update media session body for language change
     */
    function createUpdateMediaSessionBody(sessionId, languageCode) {
        const body = TactiqGoogleMeet.UpdateMediaSessionBody.create({
            mediaSessionConfig: {
                sessionId: `mediasessions/${sessionId}`,
                captionPreferences: {
                    pair: [{
                        lang1: languageCode,
                        lang2: languageCode
                    }]
                }
            },
            clientConfig: {
                captionConfig: 'client_config.caption_config'
            }
        });
        
        return TactiqGoogleMeet.UpdateMediaSessionBody.encode(body).finish();
    }

    /**
     * Persist language code in localStorage
     */
    function persistLanguageCode(languageCode) {
        try {
            const storageKey = Object.entries(localStorage)
                .find(([key]) => key.includes('rt_g3jartmcups-'));
                
            if (!storageKey) {
                throw new Error('GoogleMeet language storage key was not found');
            }

            const [key, value] = storageKey;
            const data = JSON.parse(value);
            data[2] = languageCode;
            localStorage.setItem(key, JSON.stringify(data));
        } catch (error) {
            Logger.error('Failed to persist language code', error);
        }
    }

    /**
     * Initialize RTC peer connection interception
     */
    function initializeRTCInterception() {
        if (!window.RTCPeerConnection) return false;

        const OriginalRTCPeerConnection = window.RTCPeerConnection;
        
        function TactiqRTCPeerConnection(config, constraints) {
            const connection = new OriginalRTCPeerConnection(config, constraints);
            
            connection.addEventListener('datachannel', function(event) {
                if (event.channel.label === 'collections') {
                    window.tactiqRtc.RTCPeerConnection = connection;
                    
                    event.channel.addEventListener('message', function(messageEvent) {
                        const decompressedData = decompressData(messageEvent.data);
                        
                        // Process device info
                        const deviceInfo = processDeviceInfo(decompressedData);
                        if (deviceInfo) {
                            dispatchTactiqMessage({
                                type: 'deviceinfo',
                                ...deviceInfo
                            });
                        }

                        // Process chat messages
                        const chatMessage = processChatMessage(decompressedData, true);
                        if (chatMessage) {
                            dispatchTactiqMessage({
                                type: 'speech',
                                messages: [chatMessage]
                            });
                        }
                    });
                }
            });

            return connection;
        }

        // Set up event listener for Tactiq RTC events
        document.documentElement.addEventListener('tactiq-rtc', async function(event) {
            // Wait for RTC connection
            while (!window.tactiqRtc.RTCPeerConnection) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const { type } = event.detail;

            switch (type) {
                case 'con':
                    window.tactiqRtc.RTCDataChannel_cc = window.tactiqRtc.RTCPeerConnection
                        .createDataChannel('captions', {
                            ordered: true,
                            maxRetransmits: 10,
                            id: ++messageCounter
                        });
                    break;

                case 'setGoogleMeetLanguage':
                    await handleLanguageChange(event.detail);
                    break;

                case 'debug':
                    debugMode = event.detail.enabled;
                    Logger.info(`Debug mode ${debugMode ? 'enabled' : 'disabled'}`);
                    break;

                default:
                    Logger.debug('Unknown RTC event', event.detail);
                    break;
            }
        });

        // Override createDataChannel to intercept channels
        const originalCreateDataChannel = OriginalRTCPeerConnection.prototype.createDataChannel;
        if (originalCreateDataChannel) {
            OriginalRTCPeerConnection.prototype.createDataChannel = function() {
                const connection = this;
                const channel = originalCreateDataChannel.apply(this, arguments);

                if (channel) {
                    const recreateChannel = (label) => {
                        if (channel.readyState === 'closing' || channel.readyState === 'closed') {
                            window.tactiqRtc.RTCDataChannel_cc = connection.createDataChannel(label, {
                                ordered: true,
                                maxRetransmits: 10,
                                id: ++messageCounter
                            });
                        } else {
                            setTimeout(() => recreateChannel(label), 1000);
                        }
                    };

                    if (channel.label === 'captions') {
                        channel.addEventListener('message', function(event) {
                            const message = processTranscriptMessage(decompressData(event.data));
                            if (message) {
                                addToMessageQueue(message);
                            }
                        });
                        recreateChannel('captions');
                    }

                    if (channel.label === 'meet_messages') {
                        channel.addEventListener('message', function(event) {
                            const message = processChatMessage(decompressData(event.data), true);
                            if (message) {
                                dispatchTactiqMessage({
                                    type: 'speech',
                                    messages: [message]
                                });
                            }
                        });
                        recreateChannel('meet_messages');
                    }
                }

                return channel;
            };
        }

        // Replace RTCPeerConnection
        window.RTCPeerConnection = TactiqRTCPeerConnection;
        window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

        // Add meta tag to indicate Tactiq RTC is initialized
        const metaTag = document.createElement('meta');
        metaTag.setAttribute('id', 'tactiq-rtc');
        metaTag.setAttribute('name', 'tactiq-rtc');
        metaTag.setAttribute('version', getGoogleMeetVersion());
        (document.head || document.documentElement).prepend(metaTag);

        return true;
    }

    /**
     * Handle language change request
     */
    async function handleLanguageChange(detail) {
        const { languageCode, languageId } = detail;
        
        if (!currentMediaSessionId || !languageCode) {
            Logger.error('No media session ID or language code');
            dispatchTactiqMessage({ type: 'google-meet-fallback' });
            return;
        }

        try {
            const requestBody = createUpdateMediaSessionBody(currentMediaSessionId, languageCode);
            
            // Persist language ID if provided
            if (languageId) {
                persistLanguageCode(languageId);
            }

            const response = await fetch(API_ENDPOINTS.updateMediaSession, {
                method: 'POST',
                headers: requestHeaders,
                body: requestBody
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            Logger.info('Language updated successfully', { languageCode });
        } catch (error) {
            Logger.error('Error setting Google Meet language via API', {
                languageCode,
                googleMeetMediaSessionId: currentMediaSessionId,
                error
            });
            dispatchTactiqMessage({ type: 'google-meet-fallback' });
        }
    }

    /**
     * Add message to queue for batch processing
     */
    function addToMessageQueue(message) {
        const existingIndex = messageQueue.findIndex(m => m.messageId === message.messageId);
        
        if (existingIndex > -1) {
            if (messageQueue[existingIndex].messageVersion <= message.messageVersion) {
                messageQueue.splice(existingIndex, 1, message);
            }
        } else {
            messageQueue.push(message);
        }
    }

    /**
     * Process message queue every 500ms
     */
    function startMessageProcessor() {
        setInterval(() => {
            if (messageQueue.length) {
                const messages = [...messageQueue];
                messageQueue = [];
                dispatchTactiqMessage({
                    type: 'speech',
                    messages
                });
            }
        }, 500);
    }

    /**
     * Intercept XMLHttpRequest to capture API calls
     */
    function interceptXMLHttpRequest() {
        const originalOpen = window.XMLHttpRequest.prototype.open;
        const originalSend = window.XMLHttpRequest.prototype.send;

        window.XMLHttpRequest.prototype.open = function(method, url) {
            if (url.indexOf(API_ENDPOINTS.modify) === 0) {
                this.__tactiqRequestUrl = API_ENDPOINTS.modify;
            } else if (url.indexOf(API_ENDPOINTS.queryCaptionLanguage) === 0) {
                this.__tactiqRequestUrl = API_ENDPOINTS.queryCaptionLanguage;
            }
            originalOpen.apply(this, arguments);
        };

        window.XMLHttpRequest.prototype.send = function(data) {
            if (this.__tactiqRequestUrl) {
                try {
                    switch (this.__tactiqRequestUrl) {
                        case API_ENDPOINTS.modify:
                            const modifyData = JSON.parse(data?.toString() || '[]');
                            const [, , translationLangId, transcriptLangId] = modifyData[3][0][17];
                            dispatchTactiqMessage({
                                type: 'language-changed',
                                payload: { translationLangId, transcriptLangId }
                            });
                            break;

                        case API_ENDPOINTS.queryCaptionLanguage:
                            const sessionData = JSON.parse(data?.toString() || '[]');
                            currentMediaSessionId = sessionData[1];
                            break;
                    }
                } catch (error) {
                    Logger.error('Failed to intercept request', error);
                }
            }
            originalSend.apply(this, arguments);
        };
    }

    /**
     * Intercept fetch API to capture API calls
     */
    function interceptFetch() {
        const originalFetch = window.fetch;

        window.fetch = function() {
            return new Promise((resolve, reject) => {
                try {
                    const [url, options] = arguments;

                    // Intercept createMeetingDevice to get session ID and headers
                    if (url === API_ENDPOINTS.createMeetingDevice && options.body && options.headers) {
                        try {
                            const sessionIdPattern = /\b[A-Za-z0-9_-]{28}\b/;
                            const sessionMatch = new TextDecoder().decode(options.body).match(sessionIdPattern);
                            currentMediaSessionId = currentMediaSessionId || (sessionMatch ? sessionMatch[0] : null);
                            requestHeaders = Object.fromEntries(options.headers.entries());
                        } catch (error) {
                            Logger.error('Failed to intercept createMeetingDevice request', error);
                        }
                    }
                    // Intercept updateMediaSession to track language changes
                    else if (url === API_ENDPOINTS.updateMediaSession && options.body) {
                        try {
                            const languagePattern = /\n\u0005([a-zA-Z-]+)\u0012/;
                            const bodyString = typeof options.body === 'string' ? 
                                options.body : new TextDecoder().decode(options.body);
                            const languageMatch = bodyString.match(languagePattern);
                            const languageCode = languageMatch ? languageMatch[1] : '';
                            
                            dispatchTactiqMessage({
                                type: 'language-changed',
                                payload: { languageCode }
                            });
                        } catch (error) {
                            Logger.error('Failed to intercept updateMediaSession request', error);
                        }
                    }
                } catch (error) {
                    Logger.debug('Fetch intercept error', error);
                }

                originalFetch.apply(this, arguments)
                    .then(response => {
                        try {
                            // Handle specific API responses
                            if (response.url === API_ENDPOINTS.syncMeetingSpaceCollections) {
                                response.clone().text().then(text => {
                                    const data = Uint8Array.from(window.atob(text), c => c.charCodeAt(0));
                                    const devices = processMeetingCollection(data);
                                    if (devices) {
                                        dispatchTactiqMessage({
                                            type: 'premeeting-devices',
                                            devices
                                        });
                                    }
                                }).catch(Logger.debug);
                            } else if (response.url === API_ENDPOINTS.createMeetingMessage) {
                                response.clone().text().then(text => {
                                    const data = Uint8Array.from(window.atob(text), c => c.charCodeAt(0));
                                    const message = processChatMessage(data);
                                    if (message) {
                                        dispatchTactiqMessage({
                                            type: 'speech',
                                            messages: [message]
                                        });
                                    }
                                }).catch(Logger.debug);
                            } else if (response.url === API_ENDPOINTS.createMeetingRecording) {
                                dispatchTactiqMessage({ type: 'created-recording' });
                            }
                        } catch (error) {
                            Logger.debug('Response processing error', error);
                        }
                        resolve(response);
                    })
                    .catch(reject);
            });
        };
    }

    /**
     * Handle window resize for sidebar
     */
    function handleWindowResize() {
        const originalInnerWidthGetter = Object.getOwnPropertyDescriptor(window, 'innerWidth')?.get;
        
        window.__defineGetter__('innerWidth', function() {
            const width = originalInnerWidthGetter && originalInnerWidthGetter();
            return document.body.classList.contains('tactiq-sidebar-on') ? width - 320 : width;
        });

        document.documentElement?.__defineGetter__('clientWidth', function() {
            return window.innerWidth;
        });

        document.body?.__defineGetter__('clientWidth', function() {
            return window.innerWidth;
        });
    }

    /**
     * Handle language selector interactions
     */
    function setupLanguageSelector() {
        const getCurrentLanguageCode = () => {
            try {
                const storageData = localStorage.getItem('rt_g3jartmcups-529862513');
                return LANGUAGE_CODES[String(JSON.parse(storageData)[2])] || null;
            } catch {
                return null;
            }
        };

        const findLanguageOption = (container, languageCode) => {
            return Array.from(container.children)
                .find(option => option.getAttribute('data-value') === languageCode);
        };

        const selectLanguageOption = (container, languageCode) => {
            const option = findLanguageOption(container, languageCode);
            if (!option) return;

            const clickEvent = new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true
            });
            option.dispatchEvent(clickEvent);
        };

        const getLanguageSelector = () => {
            return document.querySelector('[role="listbox"].W7g1Rb-rymPhb.O68mGe-hqgu2c');
        };

        const isLanguageSelector = (element) => {
            return element.getAttribute('role') === 'listbox' &&
                element.classList.contains('W7g1Rb-rymPhb') &&
                element.classList.contains('O68mGe-hqgu2c');
        };

        document.addEventListener('DOMContentLoaded', () => {
            // Handle language change events
            document.documentElement.addEventListener('tactiq-message', (event) => {
                if (event.detail.type === 'language-changed') {
                    const selector = getLanguageSelector();
                    if (!selector) return;
                    selectLanguageOption(selector, event.detail.payload.languageCode);
                }
            });

            // Observe for language selector creation
            new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const element = node;
                                if (!isLanguageSelector(element)) return;

                                const currentLanguage = getCurrentLanguageCode();
                                if (!currentLanguage) return;

                                selectLanguageOption(element, currentLanguage);
                            }
                        });
                    }
                }
            }).observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: false
            });
        });
    }

    /**
     * Utility function to find pattern in array
     */
    function findPattern(array, pattern, start = 0, skipIndex = -1) {
        for (let i = start; i <= array.length - pattern.length; i++) {
            let found = true;
            for (let j = 0; j < pattern.length; j++) {
                if ((skipIndex === -1 || skipIndex !== j) && array[i + j] !== pattern[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return i;
        }
        return -1;
    }

    /**
     * Find pattern with length information
     */
    function findPatternWithLength(array, pattern, start = 0, skipIndex = -1) {
        const index = findPattern(array, pattern, start, skipIndex);
        return index === -1 ? null : { index, length: pattern.length };
    }

    // Initialize everything
    function initialize() {
        if (!window.tactiq) {
            window.tactiqRtc = {};
        }

        Logger.info('Initializing Google Meet integration');

        // Set up RTC interception
        window.tactiqRtc.gotRTC = initializeRTCInterception();
        Logger.debug('RTC Connection', window.tactiqRtc.gotRTC);

        // Set up API interception
        interceptXMLHttpRequest();
        interceptFetch();

        // Set up UI handlers
        handleWindowResize();
        setupLanguageSelector();

        // Start message processing
        startMessageProcessor();

        Logger.info('Google Meet integration initialized successfully');
    }

    // Start initialization
    initialize();

})();