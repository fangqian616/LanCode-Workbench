/* AGY Web Workbench — Docs Interactive Controller */
(() => {
  'use strict';

  const STORAGE_LANG = 'agy_docs_lang';
  const STORAGE_THEME = 'agy_docs_theme';

  const I18N = {
    zh: {
      nav_demo: '交互演示',
      nav_features: '核心特性',
      nav_arch: '系统架构',
      nav_cli: '运维命令',
      nav_compare: '对比',
      hero_eyebrow: '多用户 Antigravity 浏览器工作台 · Zero External npm Deps',
      hero_title: '把一台 Antigravity 主机变成团队隔离的浏览器 AI 工作台',
      hero_sub: '专为合用开发机、实验室与远程团队打造：三栏式 TAKT Workbench 实时流式对话、文件夹递归拖拽上传、SSE 文件树热更新、Syncthing 双向同步与独立 Token / NTFS 隔离，开箱即用。',
      hero_cta_primary: '3 分钟快速部署',
      hero_cta_secondary: '体验交互工作台',
      terminal_label: 'Windows 快速部署 (PowerShell / CMD)',
      btn_copy: '复制',
      btn_copied: '已复制 ✓',
      pill_1: 'Node.js >= 20 零第三方依赖',
      pill_2: 'WebSocket /agent 自动 cwd 注入',
      pill_3: 'SSE /api/events 实时文件树',
      pill_4: 'Syncthing agy-<user> 双向同步',
      mode_sim: '交互演示',
      mode_shot: '实机截图',
      wb_theme_label: '工作台配色：',
      sim_new_task: '+ 新建任务会话',
      sim_sessions_label: '历史会话',
      qp_svg: '✨ 生成日落山脉 SVG',
      qp_server: '⚡ 检查 server.ts 路由',
      qp_sync: '🔄 查看 SSE 文件刷新机制',
      sim_placeholder: '输入指令以体验流式响应与右侧文件预览...',
      sim_send: '发送',
      sim_drop_hint: '📁 支持文件与整个文件夹递归拖拽上传',
      sim_preview_badge: '实时预览',
      shot_caption: '真实运行截图：三栏式布局（左侧会话栏 / 中间 ACP 思维链与工具卡片流 / 右侧实时 SSE 文件树与 SVG 渲染预览）',
      feat_kicker: 'CAPABILITIES',
      feat_title: '为什么选择 AGY Web Workbench',
      feat_desc: '不再让合用主机上的多个用户相互踩工作区、手动传 zip 或猜 CLI 执行进度。',
      b1_title: '三栏工作台与 ACP WebSocket 实时流',
      b1_desc: '灵感源自 TAKT 桌面工作台：左侧多会话持久化切换，中间实时展示 Thought 思考过程、工具调用状态卡与流式 Markdown 输出；portal.mjs 在服务端自动将 WebSocket params.cwd 改写至当前用户的独立沙箱目录。',
      b2_title: '文件夹拖拽上传与 SSE 文件树',
      b2_desc: '基于 webkitGetAsEntry() 递归读取本地文件夹，一键保留相对路径上传；右侧工作区通过 /api/events 实时推送变更，60 秒内修改文件带绿色脉冲高亮，底部直接预览图片、SVG 与代码。',
      b3_title: '室友 / 队员本地文件夹双向同步',
      b3_desc: '集成便携版 Syncthing（GUI 默认绑定 127.0.0.1:8384），为每位成员生成私有共享文件夹 agy-<name>，通过设备 ID 一键配对后，本地 IDE 修改与 Agent 生成产物实时双向同步。',
      b4_title: '多用户 Token 门户与 Windows ACL 隔离',
      b4_desc: '每名用户拥有独立随机 Token 与 Cookie 会话；portal.mjs 严格校验路径边界，可选配 setup-isolation.ps1 自动创建低权限 Windows 本地账户并配置 NTFS 权限，隔离底层系统目录。',
      b5_title: '主机活动监控与远程运维视图',
      b5_desc: '内置 /activity HTML 仪表盘与 /activity.json 接口，实时查看在线用户、活跃 ACP 会话与文件访问轨迹，方便管理员排查阻塞或审计使用情况。',
      b6_title: '纯 Node.js 标准库与一键批处理，5 分钟完成上线',
      b6_desc: '核心 portal.mjs、public/workbench.js 与 tools/agy-launch.mjs 零第三方 npm 运行时依赖，不触发漫长的 node_modules 构建。附带 Install / Start / Manage-Users / Manage-Syncthing / Allow-Firewall / Setup-Isolation 全套脚手架。',
      arch_kicker: 'ARCHITECTURE',
      arch_title: '请求流向与安全隔离边界',
      arch_desc: '客户端无需暴露底层 CLI 端口或本机磁盘，所有文件操作与 ACP 会话均经过 Portal 身份校验与沙箱重写。',
      a1_title: '团队成员浏览器 / 本地 IDE',
      a1_li1: '通过专属链接 /login?token=... 登录工作台',
      a1_li2: '三栏界面发起 ACP 对话，拖拽上传文件或文件夹',
      a1_li3: '可选通过 Syncthing 同步本地 IDE 目录',
      a2_title: 'portal.mjs 安全网关与静态服务',
      a2_li1: '校验 users.json Token 与 HttpOnly Cookie',
      a2_li2: '拦截路径穿越，限制文件 API 于 users/<name>',
      a2_li3: 'WS /agent 代理并自动覆盖 params.cwd',
      a3_title: 'Antigravity ACP (:3090) & 存储',
      a3_li1: 'tools/agy-launch.mjs 拉起或诊断 Antigravity CLI',
      a3_li2: 'SSE /api/events 实时监听并广播文件树变动',
      a3_li3: 'Syncthing (:8384 / :22000) 与可选 NTFS ACL 隔离',
      cli_kicker: 'OPERATIONS',
      cli_title: '开箱即用的命令行与批处理工具箱',
      cli_desc: '所有操作均有对应的 PowerShell 脚本（.ps1）与双击可用入口（.cmd），覆盖安装、用户管理、双向同步与权限隔离。',
      cmp_kicker: 'BEFORE & AFTER',
      cmp_title: '从“共享本机桌面”到“隔离 Web 工作台”',
      cmp_col1: '使用维度',
      cmp_col2: '直接共享原主机 / 命令行',
      cmp_col3: 'AGY Web Workbench',
      cmp_r1_k: '工作区隔离',
      cmp_r1_b: '所有人共用同一目录，极易误删或覆盖彼此代码',
      cmp_r1_a: '按用户分配 users/<name> 沙箱，服务端强制改写 cwd 并校验路径',
      cmp_r2_k: '文件夹上传与同步',
      cmp_r2_b: '需要手动压缩打包、走网盘或 SCP 传文件',
      cmp_r2_a: '网页直接拖拽整个文件夹上传，或通过 Syncthing 本地实时双向同步',
      cmp_r3_k: '实时进度反馈',
      cmp_r3_b: '终端纯文本刷屏，生成图片/文档后还要手动找路径打开',
      cmp_r3_a: 'Thought 思考块 + 工具调用卡片 + SSE 自动高亮新文件与底部内嵌预览',
      cmp_r4_k: '账号与系统安全',
      cmp_r4_b: '远程桌面共享或单密钥裸奔，系统磁盘完全暴露',
      cmp_r4_a: '独立 Token 轮换 + Cookie 鉴权，可选 Windows 低权限账户 NTFS ACL',
      cmp_r5_k: '部署维护成本',
      cmp_r5_b: '手动配置反向代理、鉴权服务和同步脚本',
      cmp_r5_a: '零 npm 第三方依赖，Install.cmd & Start-Server.cmd 一键拉起全栈服务',
      footer_note: 'Inspired by TAKT Workbench & powered by Node.js + Antigravity ACP + Syncthing',
      footer_top: '返回顶部 ↑'
    },
    en: {
      nav_demo: 'Live Demo',
      nav_features: 'Features',
      nav_arch: 'Architecture',
      nav_cli: 'CLI',
      nav_compare: 'Compare',
      hero_eyebrow: 'Multi-User Antigravity Portal & ACP Workbench · Zero External npm Deps',
      hero_title: 'Turn one Antigravity host into an isolated multi-user browser workbench',
      hero_sub: 'Built for shared dev machines, labs, and roommates: TAKT-style 3-column workbench, recursive folder drag-and-drop, SSE live file tree, Syncthing 2-way sync, and per-user token + NTFS isolation.',
      hero_cta_primary: '3-Minute Quick Start',
      hero_cta_secondary: 'Try Interactive Demo',
      terminal_label: 'Windows Quick Start (PowerShell / CMD)',
      btn_copy: 'Copy',
      btn_copied: 'Copied ✓',
      pill_1: 'Zero External npm Dependencies (Node >= 20)',
      pill_2: 'Auto params.cwd WS Injection',
      pill_3: 'SSE /api/events Live File Tree',
      pill_4: 'Syncthing agy-<user> 2-Way Sync',
      mode_sim: 'Interactive Demo',
      mode_shot: 'Real Screenshot',
      wb_theme_label: 'Workbench Theme:',
      sim_new_task: '+ New Task Session',
      sim_sessions_label: 'Sessions',
      qp_svg: '✨ Generate Sunset SVG',
      qp_server: '⚡ Inspect server.ts routes',
      qp_sync: '🔄 Explain SSE file watch',
      sim_placeholder: 'Type a prompt to simulate ACP streaming & live file preview...',
      sim_send: 'Send',
      sim_drop_hint: '📁 Drag & drop files or entire folders recursively',
      sim_preview_badge: 'Live Preview',
      shot_caption: 'Live production screenshot: 3-column layout (sessions sidebar / ACP thoughts & tool cards / live SSE file tree & inline SVG preview)',
      feat_kicker: 'CAPABILITIES',
      feat_title: 'Why AGY Web Workbench',
      feat_desc: 'Stop letting teammates overwrite a shared folder, zip files manually, or guess raw CLI agent progress.',
      b1_title: 'TAKT-Style 3-Column Workbench & ACP Streaming',
      b1_desc: 'Inspired by TAKT desktop ergonomics: persistent left session switcher, center stream with Thought blocks, tool-call status cards, and live Markdown; portal.mjs transparently rewrites WebSocket params.cwd to each user’s sandbox.',
      b2_title: 'Recursive Folder Drag & Drop + Live SSE Tree',
      b2_desc: 'Uses webkitGetAsEntry() to upload nested folders preserving relative paths. Right-hand file tree listens to /api/events via SSE, pulsing recently modified files (<60s) with inline SVG, Markdown, and code previews.',
      b3_title: 'Syncthing Bidirectional Workspace Sync',
      b3_desc: 'Bundles portable Syncthing setup (GUI bound to 127.0.0.1:8384) with private per-user agy-<name> folders. Pair via Device ID so local IDE edits and Agent outputs stay continuously synchronized.',
      b4_title: 'Per-User Token Portal & Optional NTFS ACL Isolation',
      b4_desc: 'Each teammate receives a random login token & HttpOnly cookie. Server routes guard against path traversal, while optional setup-isolation.ps1 creates low-privilege Windows users with strict NTFS ACLs.',
      b5_title: 'Host Activity Telemetry Dashboard',
      b5_desc: 'Built-in /activity HTML dashboard and /activity.json feed surface active users, ongoing ACP sessions, and recent file operations for effortless troubleshooting.',
      b6_title: 'Zero Third-Party Runtime Deps & One-Click Scripts',
      b6_desc: 'Core portal.mjs, public/workbench.js, and tools/agy-launch.mjs rely purely on Node.js >= 20 built-ins—no heavy node_modules. Ships with Install, Start, Manage-Users, Manage-Syncthing, Firewall, and Isolation scripts.',
      arch_kicker: 'ARCHITECTURE',
      arch_title: 'Request Flow & Isolation Boundary',
      arch_desc: 'Clients never access raw CLI sockets or host disks directly; every HTTP, SSE, and WebSocket message traverses token auth and sandbox path rewriting.',
      a1_title: 'Teammate Browser / Local IDE',
      a1_li1: 'Signs in with personalized /login?token=... link',
      a1_li2: 'Streams ACP tasks & drops folders in 3-column workbench',
      a1_li3: 'Optional Syncthing client mirrors local workspace',
      a2_title: 'portal.mjs Auth Gateway & File Server',
      a2_li1: 'Validates users.json tokens & HttpOnly session cookies',
      a2_li2: 'Blocks path traversal; scopes file APIs to users/<name>',
      a2_li3: 'Proxies WS /agent and injects params.cwd sandbox',
      a3_title: 'Antigravity ACP (:3090) & Storage',
      a3_li1: 'tools/agy-launch.mjs boots or diagnoses Antigravity CLI',
      a3_li2: 'SSE /api/events pushes live fs changes to tree view',
      a3_li3: 'Syncthing (:8384 / :22000) & optional NTFS ACL isolation',
      cli_kicker: 'OPERATIONS',
      cli_title: 'Ready-to-Run Scripts & CLI Reference',
      cli_desc: 'Every administrative workflow ships as both a clean PowerShell script (.ps1) and a double-click Windows wrapper (.cmd).',
      cmp_kicker: 'BEFORE & AFTER',
      cmp_title: 'From Shared Local Desktop to Isolated Web Workbench',
      cmp_col1: 'Dimension',
      cmp_col2: 'Shared Host / Raw CLI',
      cmp_col3: 'AGY Web Workbench',
      cmp_r1_k: 'Workspace Isolation',
      cmp_r1_b: 'Everyone edits one directory, risking accidental overwrites',
      cmp_r1_a: 'Dedicated users/<name> sandboxes with enforced server-side cwd injection',
      cmp_r2_k: 'Folder Upload & Sync',
      cmp_r2_b: 'Manual zip archives, chat uploads, or ad-hoc SCP transfers',
      cmp_r2_a: 'Drag whole folders in browser or enable Syncthing real-time 2-way sync',
      cmp_r3_k: 'Progress Visibility',
      cmp_r3_b: 'Scrolling CLI text; finding generated assets requires manual navigation',
      cmp_r3_a: 'Thought blocks, tool status cards, <60s SSE pulse highlights & inline preview',
      cmp_r4_k: 'Access & Host Security',
      cmp_r4_b: 'Shared desktop logins or unauthenticated localhost tunnels',
      cmp_r4_a: 'Per-user rotatable tokens + optional low-privilege Windows NTFS ACLs',
      cmp_r5_k: 'Setup & Maintenance',
      cmp_r5_b: 'Wire up reverse proxies, auth middleware, and watchers by hand',
      cmp_r5_a: 'Zero npm deps; Install.cmd & Start-Server.cmd start everything in minutes',
      footer_note: 'Inspired by TAKT Workbench & powered by Node.js + Antigravity ACP + Syncthing',
      footer_top: 'Back to top ↑'
    }
  };

  const CLI_DATA = {
    install: {
      zhDesc: '克隆仓库后运行 Install.cmd 初始化配置与 Syncthing（可用 -SkipSyncthing 跳过），随后启动门户并按需放行防火墙端口（TCP 3088 / Syncthing 22000 / 21027）。',
      enDesc: 'Clone the repository, run Install.cmd to bootstrap users.json & Syncthing (pass -SkipSyncthing to skip), start the portal, and optionally open firewall ports.',
      code:
`# 1. Install dependencies & optional portable Syncthing
Install.cmd
# or via PowerShell:
powershell -ExecutionPolicy Bypass -File .\\install.ps1 [-SkipSyncthing]

# 2. Start portal (:3088), ACP launcher (:3090), and Syncthing
Start-Server.cmd
# or headless without opening browser:
powershell -ExecutionPolicy Bypass -File .\\start-server.ps1 -NoBrowser -NoUi

# 3. Allow LAN access through Windows Firewall (prompts UAC)
Allow-Firewall.cmd

# 4. Stop services cleanly
Stop-Server.cmd
powershell -ExecutionPolicy Bypass -File .\\stop-server.ps1 -IncludeSyncthing`
    },
    users: {
      zhDesc: '使用 Manage-Users.cmd 或 manage-users.ps1 增删团队成员、生成免密直达登录链接或轮换泄露的 Token。',
      enDesc: 'Manage teammates with Manage-Users.cmd or manage-users.ps1: add sandboxes, print tokenized login links, rotate secrets, or remove inactive accounts.',
      code:
`# List all configured users & active status
powershell -ExecutionPolicy Bypass -File .\\manage-users.ps1 -Action List

# Add a new teammate (auto-generates random token if -Token omitted)
powershell -ExecutionPolicy Bypass -File .\\manage-users.ps1 -Action Add -Name alice

# Print ready-to-share login URL for alice
powershell -ExecutionPolicy Bypass -File .\\manage-users.ps1 -Action Link -Name alice

# Rotate token immediately and reload portal config
powershell -ExecutionPolicy Bypass -File .\\manage-users.ps1 -Action Rotate -Name alice

# Remove user (add -DeleteData to purge users\\alice)
powershell -ExecutionPolicy Bypass -File .\\manage-users.ps1 -Action Remove -Name alice`
    },
    sync: {
      zhDesc: '通过 Syncthing 为每位用户分配独立的私有同步目录（agy-<name>），双方交换 Device ID 即可完成加密点对点双向同步。',
      enDesc: 'Provision private Syncthing folders (agy-<name>) per user and pair their Device ID for continuous two-way workspace synchronization.',
      code:
`# Start Syncthing & print host Device ID
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action Start
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action DeviceId

# Check folder & device sync health
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action Status

# Ensure all users.json accounts have an agy-<name> shared folder
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action SyncFolders

# Pair alice's laptop Device ID to her private folder only
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action Pair -Name alice -DeviceId "<REMOTE-DEVICE-ID>" -DeviceName "Alice Laptop"

# Unpair a device when no longer needed
powershell -ExecutionPolicy Bypass -File .\\syncthing-sync.ps1 -Action Unpair -Name alice -DeviceId "<REMOTE-DEVICE-ID>"`
    },
    isolation: {
      zhDesc: '生产合用主机可选开启 Windows 本地低权限用户与 NTFS ACL 权限隔离，限制每个用户在操作系统层面的访问范围。',
      enDesc: 'Optional host hardening: provision low-privilege local Windows accounts and apply strict NTFS ACLs on shared/user paths.',
      code:
`# Run Setup-Isolation-Admin.cmd as Administrator, or inspect status:
powershell -ExecutionPolicy Bypass -File .\\setup-isolation.ps1 -Mode Status

# Apply full local user creation + NTFS ACL boundaries
powershell -ExecutionPolicy Bypass -File .\\setup-isolation.ps1 -Mode Full

# Re-apply NTFS ACLs only without recreating accounts
powershell -ExecutionPolicy Bypass -File .\\setup-isolation.ps1 -Mode AclOnly

# Launch isolated user session context
isolation\\Login-User.cmd alice

# Revert ACLs & optionally remove isolation accounts
powershell -ExecutionPolicy Bypass -File .\\setup-isolation.ps1 -Mode Revert -RemoveUsers`
    }
  };

  const SIM_FILES = {
    'sunset-mountains.svg': {
      age: '12s',
      fresh: true,
      type: 'svg',
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 170">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="55%" stop-color="#9d174d"/>
      <stop offset="100%" stop-color="#f59e0b"/>
    </linearGradient>
    <radialGradient id="sun" cx="50%" cy="62%" r="28%">
      <stop offset="0%" stop-color="#fde68a"/>
      <stop offset="100%" stop-color="#f97316" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="320" height="170" rx="8" fill="url(#sky)"/>
  <circle cx="160" cy="102" r="44" fill="url(#sun)"/>
  <circle cx="160" cy="102" r="22" fill="#fef08a" fill-opacity="0.9"/>
  <path d="M0 140 L72 86 L132 126 L198 76 L262 124 L320 96 L320 170 L0 170 Z" fill="#31102f"/>
  <path d="M0 152 L54 114 L118 148 L184 102 L248 144 L320 118 L320 170 L0 170 Z" fill="#14091b"/>
</svg>`
    },
    'README.md': {
      age: '4m',
      fresh: false,
      type: 'md',
      content: `# Alice Workspace\n\n- Active Sandbox: users/alice\n- Transport: WS /agent (params.cwd locked)\n- File Events: SSE /api/events\n\n## Recent Assets\n1. sunset-mountains.svg (rendered preview)\n2. server.ts (health & upload handlers)`
    },
    'server.ts': {
      age: '18m',
      fresh: false,
      type: 'code',
      content: `import { createServer } from "node:http";

export function startPortal(port = 3088) {
  return createServer((req, res) => {
    if (req.url === "/api/me") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user: "alice_dev", cwd: "users/alice" }));
      return;
    }
    res.writeHead(200).end("AGY Workbench Ready");
  }).listen(port);
}`
    }
  };

  const SIM_SESSIONS = [
    {
      id: 's1',
      title: 'Sunset SVG & Route Check',
      meta: '2 tools · 12s ago',
      prompt: '生成一个日落山脉 SVG 保存为 sunset-mountains.svg，并检查工作区文件。',
      thought: 'Scanning users/alice sandbox -> composing layered SVG sky/sun/ridges -> writing sunset-mountains.svg (892 bytes).',
      tool: 'write_file("sunset-mountains.svg") -> OK (892 B)',
      reply: '已生成 `sunset-mountains.svg`，SSE 监听器已自动刷新右侧文件树（绿色脉冲高亮表示 60 秒内更新）。点击右侧文件名即可直接预览渲染效果。',
      focusFile: 'sunset-mountains.svg'
    },
    {
      id: 's2',
      title: 'SSE & Sandbox Audit',
      meta: '1 tool · 18m ago',
      prompt: '检查 server.ts 中的 `/api/me` 隔离响应，并总结路径校验逻辑。',
      thought: 'Inspecting server.ts -> verifying user cwd confinement and safe path join rules.',
      tool: 'read_file("server.ts") -> 13 lines',
      reply: '`server.ts` 中的 `/api/me` 仅返回当前会话所属用户的 `cwd`（`users/alice`），所有读写与拖拽上传操作都经过服务端路径边界检查。',
      focusFile: 'server.ts'
    }
  ];

  const QUICK_PROMPTS = {
    svg: {
      zhPrompt: '优化 sunset-mountains.svg 的渐变色彩并输出预览摘要。',
      enPrompt: 'Refine the twilight gradient in sunset-mountains.svg and update preview.',
      thought: 'Updating radial sun glow & crisp twilight contrast -> emitting SSE change event.',
      tool: 'write_file("sunset-mountains.svg") -> UPDATED',
      zhReply: '已完成日落山脉矢量图光影优化！右侧文件树脉冲已刷新，下方实时展示了更新后的 SVG 图像。',
      enReply: 'Updated twilight contrast in `sunset-mountains.svg`! The right-hand SSE tree pulsed green and updated the live preview below.',
      file: 'sunset-mountains.svg'
    },
    server: {
      zhPrompt: '检查 server.ts 端口监听与 /api/me 端点状态。',
      enPrompt: 'Inspect server.ts default port binding and /api/me isolation handler.',
      thought: 'Parsing server.ts -> checking HTTP handler return paths and default port 3088.',
      tool: 'read_file("server.ts") -> 0 errors',
      zhReply: '检查通过：`startPortal` 默认监听 `3088`，`/api/me` 正确返回 JSON 格式的 `{ user, cwd }` 上下文。已为你切换右侧预览至 `server.ts`。',
      enReply: 'Verified `server.ts`: `startPortal` defaults to port `3088` and `/api/me` returns scoped `{ user, cwd }` JSON metadata.',
      file: 'server.ts'
    },
    sync: {
      zhPrompt: '说明浏览器拖拽上传与 Syncthing 如何同时工作？',
      enPrompt: 'Explain how browser folder drag-and-drop works alongside Syncthing.',
      thought: 'Reading README.md -> summarizing SSE /api/events + Syncthing agy-alice folder topology.',
      tool: 'read_file("README.md") -> OK',
      zhReply: '两种方式共享同一份 `users/alice` 目录：浏览器拖拽上传适合临时大批量传文件夹，Syncthing 则把本地 IDE 目录与服务端持续双向同步；任意一端改动都会触发 SSE 实时刷新文件树。',
      enReply: 'Both target `users/alice`: drag-and-drop uploads nested folders directly in browser, while Syncthing continuously mirrors local IDE edits via `agy-alice`. Either updates SSE `/api/events`.',
      file: 'README.md'
    }
  };

  let currentLang = localStorage.getItem(STORAGE_LANG) || 'zh';
  let currentTheme = localStorage.getItem(STORAGE_THEME) || 'dark';
  let activeSessionId = 's1';
  let activeFile = 'sunset-mountains.svg';
  let activeCliTab = 'install';
  let streamTimer = null;

  function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem(STORAGE_THEME, currentTheme);
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = currentTheme === 'dark' ? '☀ Light' : '☾ Dark';
    }
  }

  function applyLang(lang) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem(STORAGE_LANG, currentLang);
    const dict = I18N[currentLang];

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key && dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key && dict[key] !== undefined) {
        el.setAttribute('placeholder', dict[key]);
      }
    });

    const langBtn = document.getElementById('langToggle');
    if (langBtn) {
      langBtn.textContent = currentLang === 'zh' ? 'EN' : '中文';
    }
    renderCliTab(activeCliTab);
  }

  function flashCopyButton(btn) {
    const dict = I18N[currentLang];
    btn.classList.add('copied');
    btn.textContent = dict.btn_copied;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = dict.btn_copy;
    }, 1500);
  }

  function copyText(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopyButton(btn)).catch(() => flashCopyButton(btn));
    } else {
      flashCopyButton(btn);
    }
  }

  function renderCliTab(tabId) {
    activeCliTab = CLI_DATA[tabId] ? tabId : 'install';
    const item = CLI_DATA[activeCliTab];
    document.querySelectorAll('[data-cli-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-cli-tab') === activeCliTab);
    });
    const descEl = document.getElementById('cliTabDesc');
    const codeEl = document.getElementById('cliTabCode');
    if (descEl) descEl.textContent = currentLang === 'zh' ? item.zhDesc : item.enDesc;
    if (codeEl) codeEl.textContent = item.code;
  }

  function renderSessions() {
    const list = document.getElementById('simSessionList');
    if (!list) return;
    list.innerHTML = '';
    SIM_SESSIONS.forEach((sess) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sim-session-item' + (sess.id === activeSessionId ? ' active' : '');
      const tDiv = document.createElement('div');
      tDiv.className = 'sim-session-title';
      tDiv.textContent = sess.title;
      const mDiv = document.createElement('div');
      mDiv.className = 'sim-session-meta';
      mDiv.textContent = sess.meta;
      btn.appendChild(tDiv);
      btn.appendChild(mDiv);
      btn.addEventListener('click', () => {
        activeSessionId = sess.id;
        activeFile = sess.focusFile;
        renderSessions();
        renderSessionMessages(sess);
        renderFileTree();
        renderPreview();
      });
      list.appendChild(btn);
    });
  }

  function renderSessionMessages(sess) {
    const box = document.getElementById('simMessages');
    const titleEl = document.getElementById('simChatTitle');
    if (titleEl) titleEl.textContent = sess.title;
    if (!box) return;
    box.innerHTML = '';

    const userMsg = document.createElement('div');
    userMsg.className = 'sim-msg-user';
    userMsg.textContent = sess.prompt;
    box.appendChild(userMsg);

    const thought = document.createElement('div');
    thought.className = 'sim-thought-box';
    const tLabel = document.createElement('div');
    tLabel.className = 'sim-thought-label';
    tLabel.textContent = 'Thought (1.4s)';
    const tBody = document.createElement('div');
    tBody.textContent = sess.thought;
    thought.appendChild(tLabel);
    thought.appendChild(tBody);
    box.appendChild(thought);

    const tool = document.createElement('div');
    tool.className = 'sim-tool-card';
    const toolLeft = document.createElement('span');
    toolLeft.textContent = sess.tool;
    const toolRight = document.createElement('span');
    toolRight.className = 'sim-tool-status';
    toolRight.textContent = 'DONE';
    tool.appendChild(toolLeft);
    tool.appendChild(toolRight);
    box.appendChild(tool);

    const reply = document.createElement('div');
    reply.className = 'sim-msg-assistant';
    reply.textContent = sess.reply;
    box.appendChild(reply);
    box.scrollTop = box.scrollHeight;
  }

  function renderFileTree() {
    const tree = document.getElementById('simFileTree');
    if (!tree) return;
    tree.innerHTML = '';
    Object.keys(SIM_FILES).forEach((name) => {
      const info = SIM_FILES[name];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sim-file-item' + (name === activeFile ? ' active' : '');
      const left = document.createElement('span');
      left.className = 'sim-file-name';
      if (info.fresh) {
        const dot = document.createElement('span');
        dot.className = 'pulse-dot';
        left.appendChild(dot);
      }
      const label = document.createElement('span');
      label.textContent = name;
      left.appendChild(label);

      const age = document.createElement('span');
      age.className = 'sim-file-age' + (info.fresh ? ' fresh' : '');
      age.textContent = info.age;

      btn.appendChild(left);
      btn.appendChild(age);
      btn.addEventListener('click', () => {
        activeFile = name;
        renderFileTree();
        renderPreview();
      });
      tree.appendChild(btn);
    });
  }

  function renderPreview() {
    const label = document.getElementById('simPreviewLabel');
    const body = document.getElementById('simPreviewBody');
    if (!body) return;
    const fileObj = SIM_FILES[activeFile] || SIM_FILES['sunset-mountains.svg'];
    if (label) label.textContent = 'Preview: ' + activeFile;

    if (fileObj.type === 'svg') {
      body.innerHTML = '<div class="sim-preview-svg-wrap">' + fileObj.content + '</div>';
    } else {
      const pre = document.createElement('pre');
      pre.textContent = fileObj.content;
      body.innerHTML = '';
      body.appendChild(pre);
    }
  }

  function updatePickerLabel() {
    const model = document.getElementById('simModelSelect')?.value || 'Hydrogen';
    const mode = document.getElementById('simModeSelect')?.value || 'Code';
    const tag = document.getElementById('simModeTag');
    if (tag) tag.textContent = model + ' · ' + mode;
  }

  function triggerSimulatedPrompt(promptText, preset) {
    const box = document.getElementById('simMessages');
    const status = document.getElementById('simConnStatus');
    if (!box || !promptText.trim()) return;
    if (streamTimer) {
      clearInterval(streamTimer);
      streamTimer = null;
    }

    const userMsg = document.createElement('div');
    userMsg.className = 'sim-msg-user';
    userMsg.textContent = promptText.trim();
    box.appendChild(userMsg);

    const thought = document.createElement('div');
    thought.className = 'sim-thought-box';
    const tLabel = document.createElement('div');
    tLabel.className = 'sim-thought-label';
    tLabel.textContent = 'Thought (streaming...)';
    const tBody = document.createElement('div');
    tBody.textContent = preset ? preset.thought : 'Routing ACP prompt through WS /agent with locked cwd = users/alice...';
    thought.appendChild(tLabel);
    thought.appendChild(tBody);
    box.appendChild(thought);

    const tool = document.createElement('div');
    tool.className = 'sim-tool-card';
    const toolLeft = document.createElement('span');
    toolLeft.textContent = preset ? preset.tool : 'inspect_workspace("users/alice")';
    const toolRight = document.createElement('span');
    toolRight.className = 'sim-tool-status';
    toolRight.textContent = 'RUNNING';
    tool.appendChild(toolLeft);
    tool.appendChild(toolRight);
    box.appendChild(tool);

    const reply = document.createElement('div');
    reply.className = 'sim-msg-assistant';
    box.appendChild(reply);
    box.scrollTop = box.scrollHeight;

    if (status) status.textContent = 'ACP STREAMING...';

    const targetFile = preset ? preset.file : 'server.ts';
    const selModel = document.getElementById('simModelSelect')?.value || 'Hydrogen';
    const selMode = document.getElementById('simModeSelect')?.value || 'Code';
    const fullReply = preset
      ? (currentLang === 'en' ? preset.enReply : preset.zhReply)
      : (currentLang === 'en'
          ? `Executed inside sandbox \`users/alice\` (Model: ${selModel}, Mode: ${selMode}). Workspace updates stream to the right-hand tree via SSE \`/api/events\`.`
          : `已通过沙箱目录 \`users/alice\` 执行请求（Model: ${selModel}, Mode: ${selMode}）。所有文件更改会通过 SSE \`/api/events\` 立即反映到右侧文件树。`);

    let idx = 0;
    streamTimer = setInterval(() => {
      idx += 4;
      reply.textContent = fullReply.slice(0, idx);
      box.scrollTop = box.scrollHeight;
      if (idx >= fullReply.length) {
        clearInterval(streamTimer);
        streamTimer = null;
        tLabel.textContent = 'Thought (0.9s)';
        toolRight.textContent = 'DONE';
        if (status) status.textContent = 'ACP STREAM · READY';
        Object.keys(SIM_FILES).forEach((k) => {
          SIM_FILES[k].fresh = k === targetFile;
          if (k === targetFile) SIM_FILES[k].age = 'just now';
        });
        activeFile = targetFile;
        renderFileTree();
        renderPreview();
      }
    }, 24);
  }

  function wireEvents() {
    document.getElementById('langToggle')?.addEventListener('click', () => {
      applyLang(currentLang === 'zh' ? 'en' : 'zh');
    });

    document.getElementById('themeToggle')?.addEventListener('click', () => {
      applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    });

    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.getAttribute('data-copy') || '', btn));
    });

    document.getElementById('cliCopyBtn')?.addEventListener('click', (e) => {
      const codeEl = document.getElementById('cliTabCode');
      if (codeEl) copyText(codeEl.textContent || '', e.currentTarget);
    });

    document.querySelectorAll('[data-cli-tab]').forEach((btn) => {
      btn.addEventListener('click', () => renderCliTab(btn.getAttribute('data-cli-tab')));
    });

    const modeSimBtn = document.getElementById('modeSimBtn');
    const modeShotBtn = document.getElementById('modeShotBtn');
    const simView = document.getElementById('simView');
    const shotView = document.getElementById('shotView');
    const subthemeStrip = document.getElementById('subthemeStrip');

    modeSimBtn?.addEventListener('click', () => {
      modeSimBtn.classList.add('active');
      modeShotBtn?.classList.remove('active');
      modeSimBtn.setAttribute('aria-selected', 'true');
      modeShotBtn?.setAttribute('aria-selected', 'false');
      simView?.classList.remove('hidden');
      shotView?.classList.add('hidden');
      subthemeStrip?.classList.remove('hidden');
    });

    modeShotBtn?.addEventListener('click', () => {
      modeShotBtn.classList.add('active');
      modeSimBtn?.classList.remove('active');
      modeShotBtn.setAttribute('aria-selected', 'true');
      modeSimBtn?.setAttribute('aria-selected', 'false');
      shotView?.classList.remove('hidden');
      simView?.classList.add('hidden');
      subthemeStrip?.classList.add('hidden');
    });

    document.querySelectorAll('[data-wb-theme]').forEach((pill) => {
      pill.addEventListener('click', () => {
        const theme = pill.getAttribute('data-wb-theme');
        if (simView && theme) {
          simView.setAttribute('data-wb-theme', theme);
          document.querySelectorAll('[data-wb-theme]').forEach((p) => {
            p.classList.toggle('active', p === pill);
          });
        }
      });
    });

    document.getElementById('simModelSelect')?.addEventListener('change', updatePickerLabel);
    document.getElementById('simModeSelect')?.addEventListener('change', updatePickerLabel);

    document.getElementById('simNewTaskBtn')?.addEventListener('click', () => {
      const box = document.getElementById('simMessages');
      const titleEl = document.getElementById('simChatTitle');
      if (titleEl) titleEl.textContent = 'New Workbench Task';
      if (box) {
        box.innerHTML = '';
        const info = document.createElement('div');
        info.className = 'sim-thought-box';
        info.textContent = currentLang === 'zh'
          ? '新会话已就绪，工作目录锁定为 users/alice。点击下方快捷提示或输入任意内容体验流式输出。'
          : 'New session ready (cwd locked to users/alice). Click a quick prompt or send any message.';
        box.appendChild(info);
      }
    });

    document.querySelectorAll('[data-prompt-key]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.getAttribute('data-prompt-key');
        const preset = key ? QUICK_PROMPTS[key] : null;
        if (preset) {
          triggerSimulatedPrompt(currentLang === 'en' ? preset.enPrompt : preset.zhPrompt, preset);
        }
      });
    });

    document.getElementById('simSendBtn')?.addEventListener('click', () => {
      const input = document.getElementById('simInput');
      if (!input) return;
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      triggerSimulatedPrompt(val, null);
    });

    document.getElementById('simInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('simSendBtn')?.click();
      }
    });
  }

  function init() {
    applyTheme(currentTheme);
    renderSessions();
    renderSessionMessages(SIM_SESSIONS[0]);
    renderFileTree();
    renderPreview();
    updatePickerLabel();
    applyLang(currentLang);
    wireEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
