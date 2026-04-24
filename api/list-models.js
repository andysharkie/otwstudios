// api/list-models.js — temp: list available Gemini models for this key
export default async function handler(req, res) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'No API key' });
    try {
          const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`
                );
          const data = await r.json();
          const names = (data.models || []).map(m => m.name);
          return res.status(200).json({ count: names.length, models: names });
    } catch (e) {
          return res.status(500).json({ error: e.message });
    }
}
