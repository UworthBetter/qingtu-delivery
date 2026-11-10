/* JSON 文件存储:原子写入(临时文件 + rename),写入去抖 */
'use strict';
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, ctx) {
    this.dir = dir; this.ctx = ctx; this.E = ctx.E;
    this.file = path.join(dir, 'store.json');
    fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    this.hooks = [];   /* 数据变更后的回调(预警推送等) */
    this.data = this.blank();
  }
  load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.defs)) { this.data = this.fresh(1); this.saveNow(); }
    else this.data = Object.assign(this.blank(), d);
  }
  blank() { return { version: 1, seededAt: null, defs: [], projects: {}, rev: {}, events: [], outbox: [], flags: {}, settings: {}, extra: {} }; }
  /* 演示种子数据:以服务端「今天」为数据截至日生成 */
  fresh(version) {
    const E = this.E, today = this.ctx.today();
    const demo = E.buildDemo(today);
    const d = this.blank();
    d.version = version; d.seededAt = E.fmtFull(today);
    d.defs = demo.defs; d.projects = demo.states;
    d.defs.forEach(P => { d.rev[P.id] = 1; });
    if (this.ctx.seedHooks) this.ctx.seedHooks.forEach(fn => fn(d, today));
    return d;
  }
  reset() {
    const keep = { outbox: this.data.outbox, settings: this.data.settings };
    this.data = this.fresh(this.data.version + 1);
    this.data.outbox = keep.outbox; this.data.settings = keep.settings;
    this.changed([]);
  }
  snapshot() { return { defs: this.data.defs, projects: this.data.projects, rev: this.data.rev, extra: this.data.extra }; }
  def(pid) { return this.data.defs.find(P => P.id === pid) || null; }
  /* 带 cDate / tDay 的项目定义副本,供引擎计算 */
  prepared(pid) {
    const P = this.def(pid); if (!P) return null;
    return this.E.prep(this.E.cloneJ(P), this.ctx.today());
  }
  compute(pid) {
    const P = this.prepared(pid); if (!P) return null;
    return { P, ST: this.data.projects[pid].tasks, c: this.E.computeFor(P, this.data.projects[pid].tasks) };
  }
  applyClientChanges(upsert, remove, revs) {
    const d = this.data, pids = [];
    for (const pid of Object.keys(upsert).concat(remove)) {
      if (d.rev[pid] != null && revs[pid] != null && revs[pid] !== d.rev[pid]) return { ok: false, conflict: pid };
    }
    for (const pid of Object.keys(upsert)) {
      const u = upsert[pid];
      if (!u || !u.def || !u.state || u.def.id !== pid) continue;
      const def = this.E.stripDef(u.def), i = d.defs.findIndex(P => P.id === pid);
      if (i >= 0) d.defs[i] = def; else d.defs.push(def);
      d.projects[pid] = this.E.cloneJ(u.state);
      d.rev[pid] = (d.rev[pid] || 0) + 1; pids.push(pid);
    }
    for (const pid of remove) {
      d.defs = d.defs.filter(P => P.id !== pid); delete d.projects[pid]; delete d.rev[pid]; pids.push(pid);
    }
    this.changed(pids);
    return { ok: true, pids };
  }
  /* 服务端直接修改了某些项目(报工等)后调用 */
  touch(pids) { pids.forEach(pid => { this.data.rev[pid] = (this.data.rev[pid] || 0) + 1; }); this.changed(pids); }
  changed(pids) {
    this.data.version++;
    this.save();
    for (const fn of this.hooks) { try { fn(pids); } catch (e) { console.error('[hook]', e); } }
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.saveNow(), 150);
  }
  saveNow() {
    clearTimeout(this._t);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
module.exports = Store;
