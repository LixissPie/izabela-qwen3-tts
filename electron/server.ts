import express, { type Request, type Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { store } from './store.ts'
import { FORM_STORAGE_KEY } from '../src/forms/piper/consts.ts'

const PORT = 6789;
const DEFAULT_PIPER_API_URL = 'http://127.0.0.1:5000';
const LOCAL_FORM_FIELDS = new Set(['apiUrl']);
const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === 'development';
const expressApp = express();

type IzabelaVoice = {
    id: string;
    name: string;
    category: string;
    languageCode: string;
};

type PiperVoiceInfo = {
    name?: string;
    language?: string | { code?: string };
    sample_rate?: number;
};

type PiperVoicesResponse = Record<string, PiperVoiceInfo>;

type PiperSynthesisPayload = {
    text: string;
    voice?: string;
    length_scale?: number;
    noise_scale?: number;
    noise_w_scale?: number;
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

function getConfiguredPiperApiUrl() {
    const formData = store.get(FORM_STORAGE_KEY, {}) as Record<string, unknown>;
    const configuredUrl = process.env.PIPER_API_URL || formData.apiUrl || DEFAULT_PIPER_API_URL;

    const apiUrl = String(configuredUrl)
        .trim()
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');

    devLog('config:piper-api-url', { apiUrl });

    return apiUrl;
}

function getFormValue<T>(formData: Record<string, unknown>, key: string, fallback: T) {
    if (LOCAL_FORM_FIELDS.has(key)) {
        return fallback;
    }

    return Object.hasOwn(formData, key) ? formData[key] as T : fallback;
}

function parseLanguageCode(voiceKey: string, info: PiperVoiceInfo): string {
    if (typeof info.language === 'string' && info.language.includes('-')) {
        return info.language;
    }

    if (typeof info.language === 'object' && info.language?.code) {
        return info.language.code;
    }

    const name = info.name || voiceKey.replace(/\.onnx$/i, '');
    const match = name.match(/^([a-z]{2})_([A-Z]{2})/i);

    if (match) {
        return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
    }

    return 'en-US';
}

function mapPiperVoiceToIzabela(voiceKey: string, info: PiperVoiceInfo): IzabelaVoice {
    return {
        id: voiceKey,
        name: info.name || voiceKey.replace(/\.onnx$/i, ''),
        category: 'Piper',
        languageCode: parseLanguageCode(voiceKey, info),
    };
}

async function getPiperVoices(apiUrl: string) {
    const response = await fetchWithRetry(`${apiUrl}/voices`, {}, {
        event: 'piper:voices',
        attempts: 3,
        timeoutMs: 15000,
    });

    if (!response.ok) {
        throw new Error(`Piper voices request failed: ${response.status} ${response.statusText}`);
    }

    const voices = await response.json() as PiperVoicesResponse;

    return Object.entries(voices).map(([voiceKey, info]) => mapPiperVoiceToIzabela(voiceKey, info));
}

function buildPiperSynthesisPayload(
    formData: Record<string, unknown>,
    text: string,
    requestedVoiceId?: string,
): PiperSynthesisPayload {
    const configuredDefaultVoice = String(getFormValue(formData, 'defaultVoice', '')).trim();
    const voice = requestedVoiceId?.trim() || configuredDefaultVoice || undefined;
    const payload: PiperSynthesisPayload = { text };

    if (voice) {
        payload.voice = voice;
    }

    const lengthScale = getFormValue(formData, 'length_scale', 1);
    if (typeof lengthScale === 'number' && lengthScale > 0 && lengthScale !== 1) {
        payload.length_scale = lengthScale;
    }

    const noiseScale = getFormValue(formData, 'noise_scale', 0);
    if (typeof noiseScale === 'number' && noiseScale > 0) {
        payload.noise_scale = noiseScale;
    }

    const noiseWScale = getFormValue(formData, 'noise_w_scale', 0);
    if (typeof noiseWScale === 'number' && noiseWScale > 0) {
        payload.noise_w_scale = noiseWScale;
    }

    return payload;
}

async function synthesizeWithPiper(apiUrl: string, payload: PiperSynthesisPayload) {
    const startedAt = Date.now();

    devLog('piper:synthesize:request', {
        endpoint: `${apiUrl}/`,
        payload,
    });

    const response = await fetchWithRetry(`${apiUrl}/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    }, {
        event: 'piper:synthesize',
        attempts: 1,
        timeoutMs: 5 * 60 * 1000,
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Piper synthesis failed: ${response.status} ${response.statusText} ${responseText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    devLog('piper:synthesize:complete', {
        durationMs: Date.now() - startedAt,
        bytes: audioBuffer.length,
        contentType: response.headers.get('content-type'),
    });

    return {
        audioBuffer,
        contentType: response.headers.get('content-type') || 'audio/wav',
    };
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

async function handleListVoices(_req: Request, res: Response) {
    try {
        devLog('voices:list:start');
        const voices = await getPiperVoices(getConfiguredPiperApiUrl());

        devLog('voices:list:success', {
            count: voices.length,
            voices: voices.map((voice) => voice.id),
        });

        res.status(200).json(voices);
    } catch (error) {
        devLog('voices:list:error', {
            error: error instanceof Error ? error.message : String(error),
        });
        console.error('Error listing Piper voices:', error);
        res.status(500).json({
            error: 'Failed to list voices',
            details: error instanceof Error ? error.message : String(error),
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
                    voice,
                } = {},
            } = {},
        } = req;
        const formData = store.get(FORM_STORAGE_KEY, {}) as Record<string, unknown>;
        const requestedVoiceId = typeof voice?.id === 'string' ? voice.id : undefined;
        const piperPayload = buildPiperSynthesisPayload(
            formData,
            String(text ?? ''),
            requestedVoiceId,
        );

        if (!piperPayload.text.trim()) {
            res.status(400).json({ error: 'Text is required' });
            return;
        }

        devLog('speech:generate:start', {
            route: req.path,
            textLength: piperPayload.text.length,
            voice: piperPayload.voice,
            length_scale: piperPayload.length_scale,
            noise_scale: piperPayload.noise_scale,
            noise_w_scale: piperPayload.noise_w_scale,
        });

        const { audioBuffer, contentType } = await synthesizeWithPiper(
            getConfiguredPiperApiUrl(),
            piperPayload,
        );

        devLog('speech:response:send', {
            bytes: audioBuffer.length,
            contentType,
        });

        res.writeHead(200, {
            'Content-Type': contentType,
        });
        res.end(audioBuffer);
    } catch (error) {
        devLog('speech:error', {
            route: req.path,
            error: error instanceof Error ? error.message : String(error),
        });
        console.error('Error generating speech:', error);
        res.status(500).json({
            error: 'Failed to generate speech',
            details: error instanceof Error ? error.message : String(error),
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
