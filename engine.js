/* 擎图 · 共享排程引擎(浏览器 / 手机报工页 / Node 服务端共用)
   日序号以合同签订日为 0;基线、滚动计划、预测与关键路径均由 computeFor 前推得到。 */
(function(root,factory){var E=factory();if(typeof module==='object'&&module.exports)module.exports=E;else root.QTEngine=E;})(typeof self!=='undefined'?self:this,function(){
"use strict";
var DAY=86400000;
/* ---------- 标准工艺流程 ---------- */
var STD=[
 ['create','创建项目','销售',2,'合同评审、技术协议与项目立项'],
 ['plan','生产计划','计划专员',4,'主计划编制、产能与交期评审'],
 ['mdesign','机械设计','机械设计师',16,'总体方案、结构设计与出图'],
 ['pdesign','工艺设计','工艺工程师',7,'工艺路线、焊接工艺与工装方案'],
 ['edesign','电气设计','电气工程师',10,'电气原理图、PLC 程序与电控柜设计'],
 ['mpurchase','工艺采购','采购员',12,'钢材、型材、减速电机、车轮与机械外购件采购'],
 ['epurchase','电气采购','采购员',24,'PLC、变频器、电气元件与电缆等电气外购件采购(直送组装调试)'],
 ['cut','下料','下料班组',4,'数控等离子 / 激光切割下料'],
 ['weld','焊接','焊接班组',9,'车架与主体结构组对、焊接'],
 ['machine','加工','机加班组',7,'轴承座镗孔、端面与关键孔系加工'],
 ['paint','涂装','涂装班组',4,'喷砂除锈、底漆与面漆(结构件组装前涂装)'],
 ['assemble','组装调试','装配调试组',12,'机械总装、电气接线与空载 / 负载调试'],
 ['test','试验','质检试验组',4,'载荷试验、功能试验与出厂检验'],
 ['pack','包装','包装班组',2,'拆解、防护包装与装箱'],
 ['ship','发货','物流专员',2,'装车发运与现场交付']];
var STAGE_DEPS={create:[],plan:['create'],mdesign:['plan'],pdesign:['mdesign'],edesign:['mdesign'],mpurchase:['pdesign'],epurchase:['edesign'],cut:['mpurchase'],weld:['cut'],machine:['weld'],assemble:['paint','epurchase'],paint:['machine'],test:['assemble'],pack:['test'],ship:['pack']};

/* 责任部门(甘特图「生产进度计划表」按部门合并单元格) */
var DEPT_DEF={create:'销售部',plan:'计划部',mdesign:'技术部(设计)',pdesign:'技术部(设计)',edesign:'技术部(设计)',mpurchase:'采购部',epurchase:'采购部',cut:'生产部',weld:'生产部',machine:'生产部',paint:'生产部',assemble:'技术部',test:'技术部',pack:'生产部',ship:'生产部'};
function deptOf(t){return (t.dept&&String(t.dept).trim())||DEPT_DEF[t.id]||'—';}
function flow(sc,owners){return STD.map(function(s,i){
  return {id:s[0],name:s[1],role:s[2],dept:DEPT_DEF[s[0]]||'',owner:owners?owners[i]:'',plan:Math.max(1,Math.round(s[3]*(sc||1))),deps:STAGE_DEPS[s[0]].slice(),desc:s[4]};});}
function ownersFor(k,sales,code){return [sales,'宋雅琴',['陈志远','王磊','许晨阳'][k%3],k%2?'罗婷':'冯晓东',(code==='HD-2620'||code==='HD-2623')?'郭鹏':(k%2?'田雨':'郭鹏'),
  k%2?'彭浩':'曹敏',k%2?'林晓':'唐伟','下料班组','焊接班组','机加班组','涂装班组','装配调试组','质检试验组','包装班组','周凯'];}

/* ---------- 演示项目(当前阶段、进度与已知延误) ---------- */
/* 阶段分组与配色(生产总览、阶段条与单项目流程共用) */
var GCOL=['#9aa3b2','#2b5cd9','#6d4ad0','#5b7aa6','#3d4450'];
var SGROUPS=[['设计阶段',['mdesign','pdesign','edesign']],['采购阶段',['mpurchase','epurchase']],['制造阶段',['cut','weld','machine','paint']],['交付阶段',['assemble','test','pack','ship']]];
var PTYPES=['起重机类','AGV小车类','电动平车/KBK类'],CAT_DONE='已完成',CATS=PTYPES.concat([CAT_DONE]);
var SPEC=[
 {code:'HD-2585',type:'电动平车/KBK类',pm:'韩冬',cust:'华北重机',name:'60 吨蓄电池电动平车',sales:'刘建国',sc:1,done:24,dl:{8:3,11:-3},fd:{}},
 {code:'HD-2588',type:'AGV小车类',pm:'马骏',cust:'星驰汽车',name:'总装车间潜伏式 AGV(10 台)',sales:'刘建国',sc:1.2,done:9,dl:{2:3,8:2,11:4},fd:{}},
 {code:'HD-2593',type:'起重机类',pm:'孙蕾',cust:'东岳钢铁',name:'16 吨电动葫芦门式起重机',sales:'何静',sc:.95,done:5,dl:{8:3,11:-2},fd:{}},
 {code:'HD-2595',type:'电动平车/KBK类',pm:'赵立新',cust:'凯旋家电',name:'装配线 KBK 柔性轻轨(2 跨)',sales:'何静',sc:.8,done:14,dl:{8:2,12:-1},fd:{}},
 {code:'HD-2598',type:'电动平车/KBK类',pm:'赵立新',cust:'华北重机',name:'80 吨轨道电动平车',sales:'刘建国',sc:1.25,cur:[14],pr:.5,dl:{3:2,7:-1,8:2,10:1},fd:{}},
 {code:'HD-2602',type:'起重机类',pm:'孙蕾',cust:'东岳钢铁',name:'32/5 吨冶金桥式起重机',sales:'何静',sc:1.3,cur:[12],pr:.6,dl:{2:-2,5:4,6:3,8:3,11:2,10:-2},fd:{}},
 {code:'HD-2605',type:'电动平车/KBK类',pm:'马骏',cust:'凯旋家电',name:'总装车间 KBK 柔性轻轨系统',sales:'何静',sc:.85,cur:[10],pr:.5,dl:{5:-3,8:2},fd:{},wait:{8:1}},
 {code:'HD-2609',type:'起重机类',pm:'赵立新',cust:'宏达物流',name:'MH 型 10 吨电动葫芦门式起重机',sales:'刘建国',sc:.95,cur:[11],pr:.3,dl:{7:-2,8:3},fd:{},wait:{6:3}},
 {code:'HD-2611',type:'AGV小车类',pm:'孙蕾',cust:'星驰汽车',name:'焊装车间潜伏式 AGV(24 台)',sales:'刘建国',sc:1.45,cur:[8],pr:.4,dl:{3:1},fd:{8:4},wait:{8:1},blk:{i:8,cause:'缺料',days:4,note:'Q345B 20mm 钢板未到货,车架焊接停了两个班;供应商承诺 {+2} 到'}},
 {code:'HD-2617',type:'起重机类',pm:'马骏',cust:'北辰机械',name:'LD 型电动单梁起重机(3 台)',sales:'何静',sc:.8,cur:[9],pr:.6,dl:{2:-2,5:2,8:-1},fd:{},wait:{9:1}},
 {code:'HD-2614',type:'AGV小车类',pm:'韩冬',cust:'恒能锂电',name:'叉车式 AGV 物流系统(8 台)',sales:'何静',sc:1.2,cur:[8],pr:.35,dl:{2:-2,5:5},fd:{8:3}},
 {code:'HD-2616',type:'电动平车/KBK类',pm:'赵立新',cust:'中天钢构',name:'50 吨蓄电池电动平车(2 台)',sales:'刘建国',sc:1.1,cur:[8],pr:.2,dl:{2:2,5:-2,7:-3},fd:{},wait:{8:4},queued:true},
 {code:'HD-2618',type:'AGV小车类',pm:'孙蕾',cust:'绿野乳业',name:'冷库叉车式 AGV(6 台)',sales:'刘建国',sc:1.2,cur:[5],pr:.55,dl:{2:-2},fd:{}},
 {code:'HD-2620',type:'起重机类',pm:'韩冬',cust:'远洋港务',name:'40.5 吨集装箱门式起重机',sales:'何静',sc:1.4,cur:[4],pr:.6,dl:{2:-2},fd:{4:6}},
 {code:'HD-2622',type:'电动平车/KBK类',pm:'韩冬',cust:'鼎泰仓储',name:'KBK 柔性轻轨组合起重系统',sales:'何静',sc:.9,cur:[3,4],pr:.4,dl:{},fd:{}},
 {code:'HD-2623',type:'AGV小车类',pm:'马骏',cust:'天越光伏',name:'潜伏顶升式 AGV(12 台)',sales:'何静',sc:1,cur:[2],pr:.5,dl:{},fd:{}},
 {code:'HD-2627',type:'起重机类',pm:'赵立新',cust:'中鼎重工',name:'防爆双梁桥式起重机',sales:'刘建国',sc:1.15,cur:[1],pr:.5,dl:{},fd:{}},
 {code:'HD-2630',type:'AGV小车类',pm:'孙蕾',cust:'安途冷链',name:'重载潜伏式 AGV 搬运系统',sales:'刘建国',sc:1.2,cur:[0],pr:.5,dl:{},fd:{}}
];
function addDays(d,n){return new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);}
function parseD(s){if(!s)return null;var a=String(s).split('-');var d=new Date(+a[0],+a[1]-1,+a[2]);return isNaN(d.getTime())?null:d;}
function fmtFull(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function fmt(d){return String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

/* 由阶段描述生成:项目定义 + 任务状态(日序号以合同签订日为 0) */
function buildDemo(TODAY){
  var defs=[],states={};
  SPEC.forEach(function(sp,k){
    var allDone=sp.done!=null,tasks=flow(sp.sc,ownersFor(k,sp.sales,sp.code)),c0=allDone?tasks.length:Math.min.apply(null,sp.cur),sa={},ea={},ad={};
    tasks.forEach(function(t,i){
      ad[t.id]=Math.max(1,t.plan+(sp.dl[i]||0)+(sp.fd[i]||0));
      sa[t.id]=(t.deps.length?Math.max.apply(null,t.deps.map(function(d){return ea[d];}))+1:1)+((sp.wait&&sp.wait[i])||0);
      ea[t.id]=sa[t.id]+ad[t.id]-1;
    });
    var first=tasks[c0],last=tasks[tasks.length-1],tDay=allDone?ea[last.id]+sp.done:(sp.queued?sa[first.id]-Math.ceil(sp.wait[c0]/2):sa[first.id]+Math.round(sp.pr*ad[first.id]));
    /* 当前工序强制为进行中;其余按时间线推导(如电气采购可与下料/焊接并行进行) */
    tasks.forEach(function(t,i){t._s=allDone?'done':(sp.cur.indexOf(i)>=0&&!sp.queued?'active':(ea[t.id]<tDay?'done':(sa[t.id]<=tDay?'active':'pending')));});
    var contract=addDays(TODAY,-tDay),st={};
    tasks.forEach(function(t,i){
      if(t._s==='done')st[t.id]={s:'done',p:100,d:ad[t.id],sa:sa[t.id],ea:ea[t.id]};
      else if(t._s==='active'){var el=tDay-sa[t.id],dd=ad[t.id],pp=Math.max(0,Math.min(95,Math.round(el/dd*100)));while(pp<95&&Math.ceil(dd*(100-pp)/100)>dd-el)pp++;st[t.id]={s:'active',p:pp,d:dd,sa:sa[t.id],ea:null};}
      else st[t.id]={s:'pending',p:0,d:ad[t.id],sa:null,ea:null};
      if(sp.blk&&sp.blk.i===i&&st[t.id].s!=='done'){st[t.id].blk={cause:sp.blk.cause,note:sp.blk.note.replace(/\{\+(\d+)\}/,function(m,n){return md(addDays(TODAY,+n));}),days:sp.blk.days,at:tDay-1};st[t.id].dl=sp.blk.days;}
      delete t._s;
    });
    var id=sp.code.toLowerCase();
    defs.push({id:id,name:sp.name,code:sp.code,customer:sp.cust,type:sp.type,pm:sp.pm,contract:fmtFull(contract),tasks:tasks,parts:allDone?[]:demoParts({type:sp.type},st,TODAY)});
    states[id]={tasks:st};
  });
  defs.sort(function(a,b){return a.contract<b.contract?-1:1;});
  return {defs:defs,states:states};
}

/* ---------- 前推计算:基线 + 预测 + 关键路径 ---------- */
function topoOrder(tasks){var done={},out=[],guard=0;while(out.length<tasks.length&&guard++<500){tasks.forEach(function(t){if(done[t.id])return;if(t.deps.every(function(d){return done[d]||!tasks.some(function(x){return x.id===d;});})){done[t.id]=1;out.push(t);}});}return out;}
/* 计划开始(不早于):以日期保存,换算为距合同签订的天数 */
function psOff(P,t){if(!t.ps)return null;var d=parseD(t.ps);return d?Math.round((d-P.cDate)/DAY):null;}
function computeFor(P,ST){
  var defs0=topoOrder(P.tasks),tDay=P.tDay;
  var pb={},pe={},ps={},i,t;
  function depMax(o,t){var ds=t.deps.filter(function(d){return o[d]!=null;});return ds.length?Math.max.apply(null,ds.map(function(d){return o[d];})):0;}
  function nlt(v,id){return ps[id]!=null?Math.max(v,ps[id]):v;}
  for(i=0;i<defs0.length;i++){t=defs0[i];ps[t.id]=psOff(P,t);pb[t.id]=nlt(depMax(pe,t)+1,t.id);pe[t.id]=pb[t.id]+t.plan-1;}
  var planEnd=0;for(i=0;i<defs0.length;i++)planEnd=Math.max(planEnd,pe[defs0[i].id]);
  var fs={},fe={};
  /* 关键外购件:未到货的零件按预计到货日卡住其所需工序的开工(逾期未到按明天到货估算) */
  var pg={};(P.parts||[]).forEach(function(pt){if(pt.arrived||!pt.gate)return;var d=parseD(pt.eta),o=d?Math.round((d-P.cDate)/DAY)+1:tDay+1;o=Math.max(o,tDay+1);pg[pt.gate]=Math.max(pg[pt.gate]||0,o);});
  for(i=0;i<defs0.length;i++){
    t=defs0[i];var st=ST[t.id],ready=Math.max(nlt(depMax(fe,t)+1,t.id),st.s==='pending'&&pg[t.id]?pg[t.id]:0),s=ready,e;
    if(st.s==='done'){s=st.sa!=null?st.sa:ready;e=st.ea!=null?st.ea:s+st.d-1;e=Math.max(e,s);}
    else if(st.s==='active'){s=st.sa!=null?st.sa:ready;var rem=Math.ceil(st.d*(100-st.p)/100),base=Math.max(s,tDay);e=rem>0?base+rem-1:base;}
    else{s=Math.max(ready,tDay+1);e=s+st.d-1;}
    fs[t.id]=s;fe[t.id]=e;
  }
  var projEnd=0;for(i=0;i<defs0.length;i++)projEnd=Math.max(projEnd,fe[defs0[i].id]);
  /* 滚动计划:本工序计划开始 = 前置工序实际完成(未完成取预测完成)的最晚者 + 1(且不早于设定的计划开始);计划完成 = 计划开始 + 本工序计划工期。
     只衡量本工序自身是否超期,上游延误不会传染给下游。基线 pb/pe 仍保留,用于项目级计划交付与整体偏差。 */
  var rb={},re={},vr={};
  for(i=0;i<defs0.length;i++){t=defs0[i];rb[t.id]=nlt(depMax(fe,t)+1,t.id);re[t.id]=rb[t.id]+t.plan-1;vr[t.id]=fe[t.id]-re[t.id];}
  var succ={};defs0.forEach(function(t){t.deps.forEach(function(p){(succ[p]=succ[p]||[]).push(t.id);});});
  var lf={},ls={};
  for(i=defs0.length-1;i>=0;i--){t=defs0[i];lf[t.id]=succ[t.id]?Math.min.apply(null,succ[t.id].map(function(x){return ls[x]-1;})):projEnd;ls[t.id]=lf[t.id]-(fe[t.id]-fs[t.id]);}
  var crit={};for(i=0;i<defs0.length;i++){t=defs0[i];crit[t.id]=(ls[t.id]===fs[t.id])&&ST[t.id].s!=='done';}
  return {pb:pb,pe:pe,rb:rb,re:re,vr:vr,fs:fs,fe:fe,crit:crit,projEnd:projEnd,planEnd:planEnd,order:defs0,pg:pg};
}

/* ---------- 共享工具 ---------- */
function startOfDay(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate());}
/* 演示「今天」:可由 ?today=YYYY-MM-DD 或服务端 DEMO_TODAY 指定,否则取本机当天 */
function today(s){var d=s?parseD(s):null;return d||startOfDay(new Date());}
function cloneJ(o){return JSON.parse(JSON.stringify(o));}
/* 给项目定义补上 cDate / tDay(不序列化) */
function prep(P,TODAY){P.cDate=parseD(P.contract)||TODAY;P.tDay=Math.round((startOfDay(TODAY)-P.cDate)/DAY);return P;}
function stripDef(P){var o={};Object.keys(P).forEach(function(k){if(k!=='cDate'&&k!=='tDay')o[k]=P[k];});return cloneJ(o);}

/* ---------- 现场报工(手机扫码) ----------
   动作:start 开工 / progress 进度 / done 完工 / issue 异常上报 / resolve 解除异常
   下游确认:下一道工序「开工」即确认其前置工序已完工(cf=true);前置未报完工时需确认,
   确认后前置自动记为完工(by=downstream)。返回 {ok, code, msg, changed:[tid], autoDone:[tid]} */
var CAUSES=['缺料','图纸问题','返工','设备','等上工序','其他'];
function applyReport(P,ST,tid,a,o){
  o=o||{};var t=P.tasks.find(function(x){return x.id===tid;}),st=ST[tid],tDay=P.tDay,changed=[],autoDone=[];
  if(!t||!st)return {ok:false,code:'not_found',msg:'未找到该工序'};
  function predsOf(x){return x.deps.filter(function(d){return ST[d];});}
  function confirmPreds(){
    var nd=predsOf(t).filter(function(d){return ST[d].s!=='done';});
    if(nd.length&&!o.force)return {ok:false,code:'need_confirm',msg:'前置工序「'+nd.map(function(d){var x=P.tasks.find(function(y){return y.id===d;});return x?x.name:d;}).join('」「')+'」尚未报完工。确认开工将同时确认其已完工。',pending:nd};
    nd.forEach(function(d){var s=ST[d];if(s.sa==null)s.sa=Math.max(0,tDay-1);s.s='done';s.p=100;s.ea=Math.max(s.sa,tDay-1);s.cf=true;s.by='downstream';s.blk=null;autoDone.push(d);changed.push(d);});
    predsOf(t).forEach(function(d){if(!ST[d].cf){ST[d].cf=true;if(changed.indexOf(d)<0)changed.push(d);}});
    return null;
  }
  function start(){var r=confirmPreds();if(r)return r;st.s='active';if(st.sa==null)st.sa=tDay;st.ea=null;if(!(st.p>0))st.p=0;changed.push(tid);return null;}
  var r=null,msg='';
  if(a==='start'){
    if(st.s==='done')return {ok:false,code:'already_done',msg:'该工序已完工'};
    if(st.s==='active')return {ok:true,code:'noop',msg:'该工序已在进行中',changed:[],autoDone:[]};
    r=start();if(r)return r;msg='已开工';
  }else if(a==='progress'){
    var p=Math.round(+o.p);if(isNaN(p))return {ok:false,code:'bad_input',msg:'请填写进度'};
    if(st.s==='done')return {ok:false,code:'already_done',msg:'该工序已完工'};
    if(p>=100)return applyReport(P,ST,tid,'done',o);
    if(st.s==='pending'){r=start();if(r)return r;}
    st.p=Math.max(0,Math.min(95,p));changed.push(tid);msg='进度更新为 '+st.p+'%';
  }else if(a==='done'){
    if(st.s==='done')return {ok:true,code:'noop',msg:'该工序已完工',changed:[],autoDone:[]};
    if(st.s==='pending'){r=start();if(r)return r;}
    st.s='done';st.p=100;st.ea=Math.max(st.sa,tDay);st.blk=null;
    var hasSucc=P.tasks.some(function(x){return x.deps.indexOf(tid)>=0;});st.cf=!hasSucc;st.by='self';
    changed.push(tid);msg=hasSucc?'已报完工,待下道工序开工确认':'已报完工';
  }else if(a==='issue'){
    var cause=CAUSES.indexOf(o.cause)>=0?o.cause:'其他',days=Math.max(0,Math.min(60,Math.round(+o.days||0)));
    if(st.s==='done')return {ok:false,code:'already_done',msg:'该工序已完工,无需上报异常'};
    st.blk={cause:cause,note:String(o.note||'').slice(0,300),days:days,at:tDay};
    if(days>0){st.d+=days;st.dl=(st.dl||0)+days;}
    changed.push(tid);msg='已上报异常:'+cause+(days?',预计耽误 '+days+' 天':'');
  }else if(a==='resolve'){
    if(!st.blk)return {ok:true,code:'noop',msg:'没有待处理的异常',changed:[],autoDone:[]};
    st.blk=null;changed.push(tid);msg='异常已解除';
  }else return {ok:false,code:'bad_action',msg:'未知操作'};
  return {ok:true,code:'ok',msg:msg,changed:changed,autoDone:autoDone};
}
/* 项目汇总:计划交付、预测交付、偏差、当前工序(服务端 / 手机页共用) */
function summarize(P,ST,c){
  c=c||computeFor(P,ST);
  var act=c.order.filter(function(t){return ST[t.id].s==='active';}),allDone=c.order.every(function(t){return ST[t.id].s==='done';});
  var nx=act.length?act:c.order.filter(function(t){return ST[t.id].s!=='done';}).slice(0,1);
  return {plan:addDays(P.cDate,c.planEnd),fc:addDays(P.cDate,c.projEnd),delay:c.projEnd-c.planEnd,allDone:allDone,
    stage:nx.map(function(t){return t.name;}).join('、'),blocked:c.order.filter(function(t){return ST[t.id].blk;}).map(function(t){return t.id;})};
}

/* ---------- 关键外购件 / 齐套检查 ---------- */
var PART_CATS=['电机','减速机','PLC','变频器','驱动器','电池','传感器','车轮','钢材','其他'];
function kitStatus(P,c,tid,TODAY){
  var list=(P.parts||[]).filter(function(p){return p.gate===tid;});if(!list.length)return null;
  var need=c?addDays(P.cDate,c.fs[tid]):null,t0=startOfDay(TODAY||new Date());
  var miss=list.filter(function(p){return !p.arrived;}),over=miss.filter(function(p){var d=parseD(p.eta);return !d||d<t0;});
  var late=need?miss.filter(function(p){var d=parseD(p.eta);return d&&d>=need;}):[];
  return {total:list.length,arrived:list.length-miss.length,complete:!miss.length,missing:miss,overdue:over,blocking:late};
}
/* 演示数据:为在制项目生成关键外购件 */
function demoParts(P,ST,TODAY){
  var k=0,out=[];function add(name,cat,spec,qty,sup,gate,etaOff,arr){out.push({id:'pt'+(++k),name:name,cat:cat,spec:spec,qty:qty,supplier:sup,gate:gate,eta:fmtFull(addDays(TODAY,etaOff)),arrived:arr?fmtFull(addDays(TODAY,etaOff)):null});}
  var agv=/AGV/.test(P.type),as=ST.assemble?ST.assemble.s:'pending',ep=ST.epurchase?ST.epurchase.s:'pending';
  if(as==='done')return out;
  var arrivedAll=as==='active';
  if(agv){add('驱动轮总成','电机','伺服驱动轮 1.5kW',8,'科峰传动','assemble',-6,true);add('锂电池组','电池','48V 200Ah',4,'恒能锂电','assemble',ep==='done'||arrivedAll?-3:9,ep==='done'||arrivedAll);add('导航激光雷达','传感器','SLAM 激光',4,'思岚科技','assemble',ep==='done'||arrivedAll?-2:12,ep==='done'||arrivedAll);}
  else{add('起升减速电机','减速机','SEW KA87',2,'SEW 传动','assemble',-4,true);add('运行减速电机','减速机','SEW KA67',4,'SEW 传动','assemble',ep==='done'||arrivedAll?-1:7,ep==='done'||arrivedAll);add('变频器','变频器','ABB ACS580',3,'华东电气','assemble',ep==='done'||arrivedAll?-2:10,ep==='done'||arrivedAll);}
  add('PLC 控制器','PLC','西门子 S7-1200',1,'华东电气','assemble',ep==='done'||arrivedAll?-5:14,ep==='done'||arrivedAll);
  return out;
}

/* ---------- 延期责任账 ----------
   沿预测关键链(从最后完工的工序往回,每步取最晚完成的前置)拆解项目延期:
   每道工序 = 自身超期(实际 / 预测工期 − 计划工期)+ 等待(开工晚于前置完成)。
   自身超期按现场上报的异常原因(及耽误天数)归因,其余记为「未登记原因」;等待记为「等上工序 / 排队」。
   evs:该项目的报工记录(可省略)。 */
function md(d){return (d.getMonth()+1)+'月'+d.getDate()+'日';}
function ledger(P,ST,c,evs){
  c=c||computeFor(P,ST);evs=evs||[];
  var by={};P.tasks.forEach(function(t){by[t.id]=t;});
  var last=null;c.order.forEach(function(t){if(!last||c.fe[t.id]>c.fe[last.id])last=t;});
  var chain=[],x=last,guard=0;
  while(x&&guard++<100){chain.unshift(x);var ds=x.deps.filter(function(d){return by[d];});if(!ds.length)break;
    x=by[ds.reduce(function(a,b){return c.fe[b]>c.fe[a]?b:a;})];}
  var items=[];
  chain.forEach(function(t){
    var st=ST[t.id];
    var dur=c.fe[t.id]-c.fs[t.id]+1,own=dur-t.plan;
    var ds=t.deps.filter(function(d){return by[d];}),ready=ds.length?Math.max.apply(null,ds.map(function(d){return c.fe[d];}))+1:c.fs[t.id];
    var wait=Math.max(0,c.fs[t.id]-ready);
    if(st.s==='pending'&&!(st.dl>0)&&!(c.pg&&c.pg[t.id]&&c.fs[t.id]===c.pg[t.id]&&wait>0))return;
    var causes={};
    if(own>0){
      var left=own;
      evs.filter(function(e){return e.tid===t.id&&e.action==='issue';}).slice().reverse().forEach(function(e){
        var n=Math.min(left,e.days||0);if(n>0){causes[e.cause]=(causes[e.cause]||0)+n;left-=n;}else if(!(e.days>0)&&!causes[e.cause])causes[e.cause]=0;});
      if(st.blk&&!causes[st.blk.cause]&&left>0){var n2=Math.min(left,st.blk.days||left);causes[st.blk.cause]=n2;left-=n2;}
      if(left>0)causes['未登记原因']=(causes['未登记原因']||0)+left;
    }
    if(wait>0){if(c.pg&&c.pg[t.id]&&c.fs[t.id]===c.pg[t.id])causes['外购件未到']=wait;else causes['等上工序 / 排队']=wait;}
    if(own!==0||wait>0)items.push({id:t.id,name:t.name,dept:deptOf(t),owner:t.owner||t.role||'',own:own,wait:wait,s:st.s,crit:!!c.crit[t.id],causes:causes,blk:st.blk||null});
  });
  var delay=c.projEnd-c.planEnd,byDept={};
  items.forEach(function(it){var v=Math.max(0,it.own)+it.wait;if(v>0)byDept[it.dept]=(byDept[it.dept]||0)+v;});
  var saved=items.reduce(function(a,it){return a+(it.own<0?-it.own:0);},0);
  return {delay:delay,plan:addDays(P.cDate,c.planEnd),fc:addDays(P.cDate,c.projEnd),chain:chain.map(function(t){return t.id;}),items:items,byDept:byDept,saved:saved,text:explain(P,ST,c,items,delay)};
}
function causeTxt(cs){var k=Object.keys(cs).filter(function(k){return k!=='未登记原因'&&k!=='等上工序 / 排队'&&k!=='外购件未到';});return k.length?k.join('、'):'';}
function explain(P,ST,c,items,delay){
  var fc=md(addDays(P.cDate,c.projEnd)),pl=md(addDays(P.cDate,c.planEnd));
  var all=ST&&c.order.every(function(t){return ST[t.id].s==='done';});
  if(delay<=0){
    var open=items.filter(function(it){return it.blk;});
    return (all?'已于 '+fc+' 交付':'预计 '+fc+' 交付')+(delay<0?',比计划('+pl+')提前 '+(-delay)+' 天':',与计划持平')+(open.length?';注意:'+open.map(function(it){return it.name+'有未解除异常('+it.blk.cause+')';}).join(','):'')+'。';
  }
  var bad=items.filter(function(it){return it.own>0||it.wait>0;}).sort(function(a,b){return (Math.max(0,b.own)+b.wait)-(Math.max(0,a.own)+a.wait);}).slice(0,2);
  var parts=bad.map(function(it){
    var seg=[];if(it.own>0){var cz=causeTxt(it.causes);seg.push(it.name+(it.s==='done'?'超期 ':'预计超期 ')+it.own+' 天'+(cz?'('+cz+')':''));}
    if(it.wait>0)seg.push(it.name+(it.causes['外购件未到']?'等外购件到货 ':'等待开工 ')+it.wait+' 天');
    return seg.join('、')+',责任部门'+it.dept;});
  return (all?'交付晚 ':'预计交付晚 ')+delay+' 天('+fc+',计划 '+pl+'),因'+(parts.length?parts.join(';'):'多道工序累计延误')+(bad.length>1?'(均在关键路径上)':(bad.length?'(在关键路径上)':''))+'。';
}
/* 部门准时率:统计在某月完工(实际完成日在该月)的工序,自身未超期(相对滚动计划)即为准时 */
function deptRanking(list,ym){
  var D={};
  list.forEach(function(x){var P=x.P,ST=x.ST,c=x.c;
    P.tasks.forEach(function(t){var st=ST[t.id];if(st.s!=='done')return;var d=addDays(P.cDate,c.fe[t.id]);
      if(fmtFull(d).slice(0,7)!==ym)return;var dp=deptOf(t),r=D[dp]||(D[dp]={dept:dp,n:0,ok:0,late:0,lateDays:0});
      r.n++;if(c.vr[t.id]<=0)r.ok++;else{r.late++;r.lateDays+=c.vr[t.id];}});});
  return Object.keys(D).map(function(k){var r=D[k];r.rate=r.n?Math.round(r.ok/r.n*100):0;return r;}).sort(function(a,b){return b.rate-a.rate||b.n-a.n;});
}

/* ---------- 接单交期评估 / 班组负荷 / 工期自修正 ----------
   list:[{P(含 cDate/tDay),ST,c}],day 以「今天」为 0 的日序号。 */
/* 各班组同时可承接的项目数(与生产总览一致) */
var CAP={create:4,plan:3,mdesign:3,pdesign:2,edesign:2,mpurchase:3,epurchase:3,cut:2,weld:2,machine:2,paint:2,assemble:2,test:1,pack:2,ship:2};
var TEAM={};STD.forEach(function(s){TEAM[s[0]]=s[2];});
var MFG={cut:1,weld:1,machine:1,paint:1,assemble:1,test:1,pack:1};
function median(a){if(!a.length)return null;var b=a.slice().sort(function(x,y){return x-y;}),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2;}
function dayOf(P,n,TODAY){return Math.round((addDays(P.cDate,n)-startOfDay(TODAY))/DAY);}
/* 工期自修正:近 N 个已完工工序的实际工期 / 计划工期 */
function durationStats(list,N){
  N=N||6;var by={};
  list.forEach(function(x){x.P.tasks.forEach(function(t){var st=x.ST[t.id];if(st.s!=='done'||!STAGE_DEPS[t.id])return;
    var act=x.c.fe[t.id]-x.c.fs[t.id]+1;(by[t.id]=by[t.id]||[]).push({end:x.P.cDate.getTime()+x.c.fe[t.id]*DAY,plan:t.plan,act:act,code:x.P.code});});});
  var out={};
  Object.keys(by).forEach(function(id){var a=by[id].sort(function(p,q){return q.end-p.end;}).slice(0,N);
    var pl=a.reduce(function(s,v){return s+v.plan;},0)/a.length,ac=a.reduce(function(s,v){return s+v.act;},0)/a.length;
    out[id]={id:id,name:(STD.find(function(s){return s[0]===id;})||[])[1],n:a.length,plan:Math.round(pl*10)/10,act:Math.round(ac*10)/10,ratio:Math.round(ac/pl*100)/100};});
  return out;
}
/* 班组每日占用:未完工工序按预测起止占用对应班组 */
function teamUsage(list,TODAY,horizon){
  var use={};Object.keys(CAP).forEach(function(k){use[k]=new Array(horizon).fill(0);});
  list.forEach(function(x){x.P.tasks.forEach(function(t){var st=x.ST[t.id];if(st.s==='done'||!use[t.id])return;
    var a=Math.max(0,dayOf(x.P,x.c.fs[t.id],TODAY)),b=Math.min(horizon-1,dayOf(x.P,x.c.fe[t.id],TODAY));for(var d=a;d<=b;d++)use[t.id][d]++;});});
  return use;
}
/* 周负荷热力图:每班组每周平均占用 / 产能 */
function loadHeatmap(use,weeks,TODAY,cap){
  cap=cap||CAP;var off=(startOfDay(TODAY).getDay()+6)%7,rows=[];
  Object.keys(CAP).filter(function(k){return k!=='create'&&k!=='plan';}).forEach(function(k){var cells=[];
    for(var w=0;w<weeks;w++){var s=0,n=0;for(var d=w*7-off;d<w*7-off+7;d++){if(d<0||d>=use[k].length)continue;s+=use[k][d];n++;}
      cells.push(n?Math.round(s/n/cap[k]*100):0);}
    rows.push({id:k,team:TEAM[k],cap:cap[k],cells:cells});});
  var heads=[];for(var w=0;w<weeks;w++){var st=addDays(startOfDay(TODAY),w*7-off);heads.push(st);}
  return {rows:rows,weeks:heads};
}
/* 新订单的工序工期:同类项目中位计划工期 × 数量系数(制造类工序)× 历史修正系数 */
var REFQ={'起重机类':2,'AGV小车类':10,'电动平车/KBK类':2};
function orderTasks(list,type,qty,stats){
  var same=list.filter(function(x){return x.P.type===type;});if(!same.length)same=list;
  var refQ=REFQ[type]||2,qf=Math.max(.7,Math.min(2.5,1+.5*Math.log(Math.max(1,qty)/refQ)/Math.LN2*.5));
  return STD.map(function(s){var id=s[0],plans=same.map(function(x){var t=x.P.tasks.find(function(y){return y.id===id;});return t?t.plan:null;}).filter(function(v){return v!=null;});
    var base=Math.round(median(plans)||s[3]),plan=Math.max(1,Math.round(base*(MFG[id]?qf:1))),st=stats[id],fix=st&&st.n>=3&&Math.abs(st.ratio-1)>=.1?st.ratio:1;
    return {id:id,name:s[1],team:s[2],dept:DEPT_DEF[id],plan:plan,est:Math.max(1,Math.round(plan*fix)),fix:fix,deps:STAGE_DEPS[id].slice()};});
}
/* 有限产能排程:按依赖顺序,每道工序找最早一段连续有空位(占用 < 产能)的日期 */
function schedule(tasks,use,cap,start){
  var u={},horizon=use.mdesign.length;Object.keys(use).forEach(function(k){u[k]=use[k].slice();});
  var s={},e={},wait={},ready={};
  topoOrder(tasks).forEach(function(t){
    var r=t.deps.length?Math.max.apply(null,t.deps.map(function(d){return e[d];}))+1:start,d=r,c=cap[t.id]||99,arr=u[t.id];
    if(arr){while(d<horizon-t.est){var ok=true;for(var i=d;i<d+t.est;i++)if(arr[i]>=c){ok=false;d=i+1;break;}if(ok)break;}
      for(var j=d;j<d+t.est&&j<horizon;j++)arr[j]++;}
    ready[t.id]=r;s[t.id]=d;e[t.id]=d+t.est-1;wait[t.id]=d-r;});
  return {s:s,e:e,wait:wait,ready:ready,end:e.ship!=null?e.ship:Math.max.apply(null,Object.keys(e).map(function(k){return e[k];}))};
}
/* 评估:最早可完成、建议承诺日(含缓冲)、瓶颈、期望日差距与加产能的效果 */
function promise(list,spec,TODAY){
  var H=400,use=teamUsage(list,TODAY,H),stats=durationStats(list),tasks=orderTasks(list,spec.type,spec.qty||1,stats);
  var start=Math.max(1,spec.startIn||1);
  var r=schedule(tasks,use,CAP,start),free=schedule(tasks,Object.keys(use).reduce(function(o,k){o[k]=new Array(H).fill(0);return o;},{}),CAP,start);
  var span=r.end-start+1,buffer=Math.max(3,Math.round(span*.05));
  /* 只看决定交付日的链路(从发货往回,每步取最晚完成的前置)上的排队 */
  var byId={};tasks.forEach(function(t){byId[t.id]=t;});
  var chain=[],x=byId.ship||tasks[tasks.length-1],g=0;
  while(x&&g++<50){chain.push(x);if(!x.deps.length)break;x=byId[x.deps.reduce(function(a,b){return r.e[b]>r.e[a]?b:a;})];}
  var bott=chain.filter(function(t){return r.wait[t.id]>0;}).sort(function(a,b){return r.wait[b.id]-r.wait[a.id];});
  var longest=chain.slice().sort(function(a,b){return b.est-a.est;})[0];
  var whatIf=bott.slice(0,2).map(function(t){var c2=Object.assign({},CAP);c2[t.id]++;var r2=schedule(tasks,use,c2,start);return {id:t.id,team:t.team,gain:r.end-r2.end,end:addDays(startOfDay(TODAY),r2.end)};});
  /* 链路上所有排队的班组都加 1 个工位(或加班)时的效果 */
  var allIf=null;if(bott.length){var c3=Object.assign({},CAP);bott.forEach(function(t){c3[t.id]++;});var r3=schedule(tasks,use,c3,start);allIf={teams:bott.map(function(t){return t.team;}),gain:r.end-r3.end,end:addDays(startOfDay(TODAY),r3.end)};}
  var desired=spec.desired?parseD(spec.desired):null,gap=null;
  if(desired)gap=Math.round((desired-addDays(startOfDay(TODAY),r.end+buffer))/DAY);
  /* 新订单加入后的负荷 */
  var withNew={};Object.keys(use).forEach(function(k){withNew[k]=use[k].slice();});
  tasks.forEach(function(t){if(!withNew[t.id])return;for(var d=r.s[t.id];d<=r.e[t.id]&&d<H;d++)withNew[t.id][d]++;});
  return {tasks:tasks.map(function(t){return Object.assign({},t,{start:addDays(startOfDay(TODAY),r.s[t.id]),end:addDays(startOfDay(TODAY),r.e[t.id]),wait:r.wait[t.id],stat:stats[t.id]||null});}),
    finish:addDays(startOfDay(TODAY),r.end),promise:addDays(startOfDay(TODAY),r.end+buffer),buffer:buffer,ideal:addDays(startOfDay(TODAY),free.end),queueDays:r.end-free.end,
    bottleneck:bott.length?{id:bott[0].id,team:bott[0].team,name:bott[0].name,wait:r.wait[bott[0].id]}:null,chain:chain.map(function(t){return t.id;}),waits:bott.map(function(t){return {id:t.id,name:t.name,team:t.team,wait:r.wait[t.id]};}),allIf:allIf,longest:longest?{id:longest.id,name:longest.name,team:longest.team,days:longest.est}:null,whatIf:whatIf,desired:desired,gap:gap,stats:stats,use:use,withNew:withNew};
}

return {DAY:DAY,PART_CATS:PART_CATS,kitStatus:kitStatus,demoParts:demoParts,CAP:CAP,TEAM:TEAM,durationStats:durationStats,teamUsage:teamUsage,loadHeatmap:loadHeatmap,orderTasks:orderTasks,schedule:schedule,promise:promise,CAUSES:CAUSES,applyReport:applyReport,summarize:summarize,ledger:ledger,explain:explain,deptRanking:deptRanking,md:md,STD:STD,STAGE_DEPS:STAGE_DEPS,DEPT_DEF:DEPT_DEF,deptOf:deptOf,flow:flow,ownersFor:ownersFor,GCOL:GCOL,SGROUPS:SGROUPS,PTYPES:PTYPES,CAT_DONE:CAT_DONE,CATS:CATS,SPEC:SPEC,
  addDays:addDays,parseD:parseD,fmtFull:fmtFull,fmt:fmt,buildDemo:buildDemo,topoOrder:topoOrder,psOff:psOff,computeFor:computeFor,
  startOfDay:startOfDay,today:today,cloneJ:cloneJ,prep:prep,stripDef:stripDef};
});
