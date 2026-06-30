import type { RJSFSchema } from '@rjsf/utils'

export const schema: RJSFSchema = {
    title: "Piper TTS",
    type: "object",
    properties: {
        apiUrl: {
            type: "string",
            title: "Piper API URL",
            description: "Base URL for the Piper HTTP server (python -m piper.http_server).",
            default: "http://127.0.0.1:5000",
            "x-index": 0
        },
        defaultVoice: {
            type: "string",
            title: "Default Voice",
            description: "Voice model file name (e.g. en_US-lessac-medium.onnx). Used when the client does not specify a voice.",
            default: "",
            "x-index": 1
        },
        length_scale: {
            type: "number",
            title: "Speaking Speed",
            description: "Values below 1.0 are faster, above 1.0 are slower.",
            default: 1,
            minimum: 0.1,
            maximum: 3,
            "x-index": 2
        },
        noise_scale: {
            type: "number",
            title: "Noise Scale",
            description: "Optional speaking variability. Leave at 0 to use the Piper server default.",
            default: 0,
            minimum: 0,
            maximum: 2,
            "x-index": 3
        },
        noise_w_scale: {
            type: "number",
            title: "Phoneme Width Variability",
            description: "Optional phoneme width variability. Leave at 0 to use the Piper server default.",
            default: 0,
            minimum: 0,
            maximum: 2,
            "x-index": 4
        }
    }
};
