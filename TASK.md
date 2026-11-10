# Task (Claude Code)
Improve `index.html` (single self-contained HTML frontend demo, mock data, UI text in Simplified Chinese, material-handling equipment projects). Keep the current clean light style (same as `reference.html`); do not make it flashy. Do not break the single-project page (tiles, 生产流程实况, 任务看板/甘特图 sync).

On the project overview (home) page add:
1. **项目分组**: group projects (e.g. by status 进行中/预警/已完成, by customer, or by product type; let the user choose the grouping via a small segmented control; groups are collapsible with counts). Add a few more mock projects so grouping is meaningful (~10-12 projects total).
2. **搜索**: a search box filtering by project name, contract no., customer, owner; live filtering with highlighted matches and an empty state. Can combine with status filter chips.
3. **视图切换**: keep the current card view and add a **列表视图** (table: 项目名称, 合同号, 客户, 当前工序, 进度条, 计划交付, 预测交付, 偏差天数, 状态, 负责人), sortable columns, row click opens project detail. Remember the chosen view in localStorage.
Grouping and search must work in both views. Page must scroll normally. Keep it one self-contained HTML file `index.html`. Verify there are no JS errors (e.g. run it in a headless browser if available) before finishing.
