import express, { type Request, type Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { store } from './store.ts'
import { FORM_STORAGE_KEY } from '../src/forms/xtts/consts.ts'

const PORT = 6789;
const DEFAULT_TTS_API_URL = "http://192.168.100.12:42003";
const LOCAL_FORM_FIELDS = new Set(['apiUrl']);
const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === 'development';
const expressApp = express();

type ApiParameter = {
    parameter_name?: string;
};
type ApiEndpoint = {
    parameters?: ApiParameter[];
};
type ApiInfo = {
    named_endpoints?: Record<string, ApiEndpoint>;
};
type GradioDependency = {
    id?: number;
    api_name?: string | false;
};
type GradioConfig = {
    dependencies?: GradioDependency[];
};
type GeneratedAudio = {
    path?: string;
    url?: string | null;
    orig_name?: string | null;
    mime_type?: string | null;
};
type GenerateVoiceDesignResponseData = [GeneratedAudio, string?];
type TtsPayload = {
    text: unknown;
    language: unknown;
    voice_description: string;
    seed: unknown;
};

const VOICE_DESIGN_ID = 'voice-design';
const DEFAULT_VOICE_DESCRIPTION =
    'Speak clearly with a warm, natural tone and calm pacing.';
const VOICE_DESIGN_VOICE = {
    id: VOICE_DESIGN_ID,
    name: 'Voice Design',
    category: 'Qwen3-TTS',
    languageCode: 'en-US',
};

function devLog(event: string, data?: Record<string, unknown>) {
    if (!IS_DEV) {
        return;
    }

    console.log(`[dev:server] ${event}`, data ?? '');
}

function describeError(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) {
        return { message: String(error) };
    }

    const cause = 'cause' in error ? error.cause : undefined;

    return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: cause instanceof Error
            ? {
                name: cause.name,
                message: cause.message,
                stack: cause.stack,
            }
            : cause,
    };
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit = {}, options: {
    attempts?: number;
    timeoutMs?: number;
    event?: string;
} = {}) {
    const attempts = options.attempts ?? 3;
    const timeoutMs = options.timeoutMs ?? 15000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            devLog(`${options.event ?? 'http'}:attempt`, {
                attempt,
                url,
                method: init.method ?? 'GET',
            });

            const response = init.signal
                ? await fetch(url, init)
                : await fetchWithTimeout(url, timeoutMs, init);

            devLog(`${options.event ?? 'http'}:response`, {
                attempt,
                status: response.status,
                contentType: response.headers.get('content-type'),
            });

            return response;
        } catch (error) {
            lastError = error;
            devLog(`${options.event ?? 'http'}:error`, {
                attempt,
                ...describeError(error),
            });

            if (attempt < attempts) {
                const waitMs = attempt * 1000;
                devLog(`${options.event ?? 'http'}:retry`, {
                    nextAttempt: attempt + 1,
                    waitMs,
                });
                await delay(waitMs);
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function getGradioApiUrl(apiUrl: string, path: string) {
    return `${apiUrl}/gradio_api/${path.replace(/^\/+/, '')}`;
}

async function getTtsApiInfo(apiUrl: string) {
    const response = await fetchWithRetry(getGradioApiUrl(apiUrl, 'info'), {}, {
        event: 'tts-api:info',
        attempts: 3,
        timeoutMs: 15000,
    });

    if (!response.ok) {
        throw new Error(`TTS API info request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as ApiInfo;
}

async function getTtsConfig(apiUrl: string) {
    const response = await fetchWithRetry(`${apiUrl}/config`, {}, {
        event: 'tts-api:config',
        attempts: 3,
        timeoutMs: 15000,
    });

    if (!response.ok) {
        throw new Error(`TTS API config request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as GradioConfig;
}

function getVoiceDesignFnIndex(config: GradioConfig) {
    const dependency = config.dependencies?.find((item) => item.api_name === 'generate_voice_design');

    if (typeof dependency?.id !== 'number') {
        throw new Error('TTS API config does not expose generate_voice_design dependency id');
    }

    return dependency.id;
}

async function runVoiceDesign(apiUrl: string, payload: TtsPayload) {
    const config = await getTtsConfig(apiUrl);
    const fnIndex = getVoiceDesignFnIndex(config);
    const requestBody = {
        data: [
            payload.text,
            payload.language,
            payload.voice_description,
            payload.seed,
        ],
        event_data: null,
        fn_index: fnIndex,
        trigger_id: null,
        session_hash: Math.random().toString(36).slice(2),
    };
    const startedAt = Date.now();

    devLog('tts-api:run:request', {
        endpoint: '/gradio_api/run/generate_voice_design',
        fnIndex,
        payload,
    });

    const response = await fetchWithRetry(getGradioApiUrl(apiUrl, 'run/generate_voice_design'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    }, {
        event: 'tts-api:run',
        attempts: 1,
        timeoutMs: 10 * 60 * 1000,
    });

    const responseText = await response.text();

    devLog('tts-api:run:response-body', {
        status: response.status,
        durationMs: Date.now() - startedAt,
        bodyPreview: responseText.slice(0, 1000),
    });

    if (!response.ok) {
        throw new Error(`TTS API run failed: ${response.status} ${response.statusText} ${responseText}`);
    }

    const data = JSON.parse(responseText) as { data?: GenerateVoiceDesignResponseData };

    if (!data.data?.[0]?.url) {
        throw new Error(`TTS API did not return an audio file URL: ${responseText}`);
    }

    return data.data;
}

expressApp.use(cors());
expressApp.use(morgan('dev', {
    skip: () => !IS_DEV,
}));
expressApp.use(express.json());
expressApp.use((req, res, next) => {
    const startedAt = Date.now();

    devLog('request:start', {
        method: req.method,
        path: req.path,
        query: req.query,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        body: req.body,
    });

    res.on('finish', () => {
        devLog('request:finish', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            contentType: res.getHeader('content-type'),
        });
    });

    next();
});

function getConfiguredTtsApiUrl() {
    const formData = store.get(FORM_STORAGE_KEY, {}) as Record<string, unknown>;
    const configuredUrl = process.env.XTTS_API_URL || formData.apiUrl || DEFAULT_TTS_API_URL;

    const apiUrl = String(configuredUrl)
        .trim()
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');

    devLog('config:tts-api-url', { apiUrl });

    return apiUrl;
}

function getFormValue<T>(formData: Record<string, unknown>, key: string, fallback: T) {
    if (LOCAL_FORM_FIELDS.has(key)) {
        return fallback;
    }

    return Object.hasOwn(formData, key) ? formData[key] as T : fallback;
}

function getVoiceDescription(formData: Record<string, unknown>) {
    const configuredDescription = getFormValue(
        formData,
        'qwenVoiceDescription',
        getFormValue(formData, 'qwenStyleInstruction', DEFAULT_VOICE_DESCRIPTION),
    );

    return String(configuredDescription || DEFAULT_VOICE_DESCRIPTION);
}

async function handleListVoices(_req: Request, res: Response) {
    const voices = [VOICE_DESIGN_VOICE];

    res.status(200).json(voices);

    try {
        devLog('voices:list:start');
        const apiInfo = await getTtsApiInfo(getConfiguredTtsApiUrl());
        const voiceDesignEndpoint = apiInfo.named_endpoints?.['/generate_voice_design'];

        if (!voiceDesignEndpoint) {
            devLog('voices:list:metadata-missing', {
                endpoint: '/generate_voice_design',
            });
            return;
        }

        devLog('voices:list:success', {
            endpoint: '/generate_voice_design',
            voices: [VOICE_DESIGN_ID],
        });
    } catch (error) {
        devLog('voices:list:error', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

expressApp.get('/list-voices', handleListVoices);
expressApp.post('/list-voices', handleListVoices);

async function handleSynthesizeSpeech(req: Request, res: Response) {
    try {
        const {
            body: {
                payload: {
                    text,
                },
            },
        } = req
        const formData = store.get(FORM_STORAGE_KEY, {}) as Record<string, unknown>
        const language = getFormValue(formData, 'language', 'English')
        const voiceDescription = getVoiceDescription(formData)
        const seed = getFormValue(formData, 'qwenSeed', -1)

        devLog('speech:generate:start', {
            route: req.path,
            textLength: typeof text === 'string' ? text.length : undefined,
            language,
            voiceDescription,
            seed,
        });

        const ttsPayload = {
            text,
            language,
            voice_description: voiceDescription,
            seed,
        };

        devLog('tts-api:predict:request', {
            endpoint: '/generate_voice_design',
            payload: ttsPayload,
        });

        const resultData = await runVoiceDesign(getConfiguredTtsApiUrl(), ttsPayload);
        const audio = resultData[0];
        const audioUrl = audio?.url;

        if (!audioUrl) {
            throw new Error('TTS API did not return an audio file URL')
        }

        devLog('speech:generate:complete', {
            audioUrl,
            status: resultData[1],
        });

        const audioResponse = await fetch(audioUrl);

        if (!audioResponse.ok || !audioResponse.body) {
            throw new Error(`Failed to fetch generated audio: ${audioResponse.status} ${audioResponse.statusText}`)
        }

        const contentType = audioResponse.headers.get('content-type') || audio.mime_type || 'audio/wav'
        const contentLength = audioResponse.headers.get('content-length')

        devLog('speech:audio-fetch:success', {
            contentType,
            contentLength,
        });

        res.writeHead(200, {
            'Content-Type': contentType,
        })

        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())
        devLog('speech:response:send', {
            bytes: audioBuffer.length,
        });
        res.end(audioBuffer)
    } catch (error) {
        devLog('speech:error', {
            route: req.path,
            error: error instanceof Error ? error.message : String(error),
        });
        console.error('Error generating speech:', error);
        res.status(500).json({ 
            error: 'Failed to generate speech',
            details: error instanceof Error ? error.message : String(error)
        });
    }
}

expressApp.post('/synthesize-speech', handleSynthesizeSpeech);
expressApp.post('/synthesize-speech/stream', handleSynthesizeSpeech);

export function startExpressServer() {
    return new Promise((resolve, reject) => {
        const server = expressApp.listen(PORT, () => {
            console.log(`Express server started on port ${PORT}`);
            devLog('server:listening', { port: PORT });
            resolve(server);
        });
        
        server.on('error', (err) => {
            devLog('server:error', { error: err.message });
            console.error('Failed to start Express server:', err);
            reject(err);
        });
    });
}

export default expressApp;
