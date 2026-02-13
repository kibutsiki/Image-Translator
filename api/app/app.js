const jsonResponse = (data, init = {}) => {
	const headers = new Headers(init.headers || {});
	headers.set("Content-Type", "application/json");
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "Content-Type");
	return new Response(JSON.stringify(data), {
		...init,
		headers
	});
};

const handleTranslate = async (request, env) => {
	const payload = await request.json().catch(() => null);
	if (!payload || !payload.text || !payload.targetLang) {
		return jsonResponse({ error: "Missing text or targetLang." }, { status: 400 });
	}

	const apiKey = env.DEEPL_API_KEY;
	if (!apiKey) {
		return jsonResponse({ error: "DEEPL_API_KEY is not configured." }, { status: 500 });
	}

	const apiUrl = env.DEEPL_API_URL || "https://api-free.deepl.com/v2/translate";
	const body = new URLSearchParams({
		text: payload.text,
		target_lang: payload.targetLang
	});

	const response = await fetch(apiUrl, {
		method: "POST",
		headers: {
			Authorization: `DeepL-Auth-Key ${apiKey}`,
			"Content-Type": "application/x-www-form-urlencoded"
		},
		body
	});

	if (!response.ok) {
		const details = await response.text();
		return jsonResponse({ error: "DeepL request failed.", details }, { status: 502 });
	}

	const data = await response.json();
	const translatedText = data.translations && data.translations[0] && data.translations[0].text;

	return jsonResponse({ translatedText: translatedText || "" });
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return jsonResponse({ ok: true });
		}

		if (url.pathname === "/translate" && request.method === "POST") {
			return handleTranslate(request, env);
		}

		return jsonResponse({ error: "Not found." }, { status: 404 });
	}
};
