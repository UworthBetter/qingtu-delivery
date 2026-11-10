/* 演示种子:生成近两天的现场报工记录,让「现场动态」「老板早报」「责任账」开箱就有内容。
   故事线:HD-2611 星驰汽车 24 台潜伏式 AGV,焊接因 Q345B 钢板缺料停了两个班,预计交付晚 6 天。 */
'use strict';
module.exports = function (ctx) {
  const { E } = ctx;
  (ctx.seedHooks = ctx.seedHooks || []).push((d, today) => {
    const now = Date.now(), H = 3600 * 1000, ev = [];
    let k = 0;
    const add = (code, tid, action, ago, extra) => {
      const P = d.defs.find(x => x.code === code); if (!P) return;
      const t = P.tasks.find(x => x.id === tid), st = d.projects[P.id].tasks[tid]; if (!t || !st) return;
      ev.push(Object.assign({ id: 'seed' + (++k), ts: now - ago * H, day: E.fmtFull(today), pid: P.id, tid, step: t.name, dept: E.deptOf(t), action, p: st.p, cause: null, note: '', days: 0, who: null, autoDone: [], photo: null, msg: '' }, extra || {}));
    };
    const P11 = d.defs.find(x => x.code === 'HD-2611');
    const blk = P11 && d.projects[P11.id].tasks.weld.blk;
    add('HD-2611', 'weld', 'issue', 17, { cause: '缺料', days: 4, note: blk ? blk.note : 'Q345B 钢板未到货', who: '焊接班组 · 张建' });
    add('HD-2611', 'weld', 'progress', 26, { p: 35, who: '焊接班组 · 张建' });
    add('HD-2611', 'weld', 'start', 72, { who: '焊接班组 · 张建' });
    add('HD-2614', 'weld', 'progress', 3, { who: '焊接班组 · 刘强' });
    add('HD-2605', 'paint', 'progress', 4, { who: '涂装班组 · 周平' });
    add('HD-2617', 'machine', 'progress', 5, { who: '机加班组 · 吴刚' });
    add('HD-2609', 'assemble', 'progress', 6, { who: '装配调试组 · 陈立' });
    add('HD-2602', 'test', 'progress', 20, { who: '质检试验组 · 郑涛' });
    add('HD-2598', 'ship', 'start', 22, { who: '周凯' });
    add('HD-2620', 'pdesign', 'progress', 23, { who: '冯晓东' });
    d.events = ev.sort((a, b) => b.ts - a.ts);
  });
};
