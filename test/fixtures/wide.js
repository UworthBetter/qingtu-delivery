/* 把 wide_base_snapshot.json(多维表格「项目执行表」合成示例:22 条虚构记录 / 45 个字段,字段结构与真实表一致)还原成飞书 bitable v1 接口的返回形态:
   fields = [{field_name, type}],records = [{record_id, fields:{字段名: 值}}](日期为毫秒时间戳,文本为富文本数组,单选为选项名) */
'use strict';
const snap = require('./wide_base_snapshot.json')[0].schema.data;
const fm = snap.table.fieldMap;
const order = snap.table.views[0] && snap.table.viewMap && snap.table.viewMap[snap.table.views[0]] ? null : null;
const fields = Object.keys(fm).map(id => ({ field_id: id, field_name: fm[id].name, type: fm[id].type }));
const opt = id => { for (const f of Object.values(fm)) for (const o of ((f.property || {}).options || [])) if (o.id === id) return o.name; return id; };
const ids = Object.keys(snap.recordMap), rank = (snap.table.rankInfo || {}).rankMap || {};
ids.sort((a, b) => String(rank[a] || '').localeCompare(String(rank[b] || '')) || ids.indexOf(a) - ids.indexOf(b));
const records = ids.map(rid => {
  const f = {};
  for (const [fid, c] of Object.entries(snap.recordMap[rid])) {
    if (!c || c.value == null || !fm[fid]) continue;
    f[fm[fid].name] = fm[fid].type === 3 ? opt(c.value) : c.value;
  }
  return { record_id: rid, fields: f };
});
module.exports = { fields, records };

/* 与 /api/import/parse 的飞书读取路径一致:接口返回 → 二维数组(首行为字段名,日期按东八区转 YYYY-MM-DD) */
module.exports.rows = () => require('../../lib/feishu.js').bitableRows(fields, records, 'Asia/Shanghai');
