import type { RJSFSchema } from '@rjsf/utils'

export const schema: RJSFSchema = {
    title: "Qwen3-TTS Voice Design",
    type: "object",
    properties: {
        apiUrl: {
            type: "string",
            title: "TTS API URL",
            description: "Base URL for the Qwen3-TTS API. Query strings such as ?view=api are ignored automatically.",
            default: "http://192.168.100.12:42003",
            "x-index": 0
        },
        language: {
            type: "string",
            title: "Language",
            enum: [
                "Auto",
                "Italian",
                "Chinese",
                "English",
                "Japanese",
                "Korean",
                "French",
                "German",
                "Spanish",
                "Portuguese",
                "Russian"
            ],
            default: "English",
            "x-index": 1
        },
        qwenVoiceDescription: {
            type: "string",
            title: "Voice Description",
            description: "Describe the voice, tone, emotion, pacing, accent, or delivery style for Qwen3-TTS Voice Design.",
            default: "Speak clearly with a warm, natural tone and calm pacing.",
            "x-index": 2
        },
        qwenSeed: {
            type: "integer",
            title: "Seed",
            description: "Use -1 for an automatic random seed.",
            default: -1,
            "x-index": 3
        }
    }
};
