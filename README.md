# WAI Master OS — PWA

## 文件列表
- `index.html` — 主程序
- `manifest.json` — PWA配置
- `sw.js` — Service Worker（离线支持）
- `icon-192.png` — App图标（小）
- `icon-512.png` — App图标（大）

## 怎么部署（免费）

### 方法1：GitHub Pages（推荐）

1. 去 github.com，创建新repo，名字随意（例：wai-os）
2. 把这5个文件全部upload上去
3. 去 Settings → Pages → Source → main branch → Save
4. 你的app网址会是：https://[你的username].github.io/wai-os/
5. 手机打开这个网址 → 点"添加到主屏幕"→ 变成app

### 方法2：Netlify（最简单）

1. 去 netlify.com，注册免费账号
2. 把这个文件夹直接拖拽进去
3. 自动deploy，给你一个网址
4. 手机打开 → 安装

## 手机安装步骤

### Android（Chrome）
1. 打开网址
2. 右上角"⋮"→ "添加到主屏幕"
3. 或者等顶部出现"⬇ 安装App"按钮，点一下

### iPhone（Safari）
1. 打开网址（必须用Safari）
2. 下方分享按钮 → "添加到主屏幕"
3. 点"添加"

完成！桌面会出现WAI.SYS图标。
