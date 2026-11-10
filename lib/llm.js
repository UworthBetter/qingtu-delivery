/* 大模型(可选):配置 ANTHROPIC_API_KEY 后用 Claude 撰写早报 / 识别表格,未配置或失败时返回 null,调用方使用模板 / 规则 */
'use strict';
let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (client) return client;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    client = new Anthropic();
    return client;
  } catch (e) {
    console.warn('[llm] 未安装 @anthropic-ai/sdk(运行 npm install),改用模板');
    return null;
  }
}
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

/* 单次调用,返回纯文本;拒答或出错返回 null */
async function complete(system, user, opts) {
  const c = getClient(); if (!c) return null;
  try {
    const res = await c.beta.messages.create({
      model: MODEL(),
      max_tokens: (opts && opts.maxTokens) || 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: Object.assign({ effort: (opts && opts.effort) || 'medium' }, opts && opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}),
      system,
      messages: [{ role: 'user', content: user }]
    }, { timeout: 60000 });
    if (res.stop_reason === 'refusal') { console.warn('[llm] 模型拒答,改用模板'); return null; }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return text || null;
  } catch (e) {
    const mod = require('@anthropic-ai/sdk'); const A = mod.default || mod;
    if (e instanceof A.AuthenticationError) console.warn('[llm] API Key 无效,改用模板');
    else if (e instanceof A.RateLimitError) console.warn('[llm] 触发限流,改用模板');
    else if (e instanceof A.APIError) console.warn('[llm] 接口错误 ' + e.status + ',改用模板');
    else console.warn('[llm] 调用失败:' + e.message + ',改用模板');
    return null;
  }
}
/* 结构化输出:按 JSON Schema 返回对象(output_config.format) */
async function completeJson(system, user, schema, opts) {
  const t = await complete(system, user, Object.assign({}, opts, { schema })); if (!t) return null;
  try { return JSON.parse(t); } catch (e) { console.warn('[llm] 返回内容不是 JSON,改用规则'); return null; }
}
module.exports = { complete, completeJson, ready: () => !!getClient() };
