# 荞荞的照片

家里的老人用手机，连上家里的 Wi-Fi，就能看荞荞的照片和视频。照片一直在这台 Mac 上，不会上传到网上。

适合一台一直开着的旧 Mac（按 2015 款 Intel MacBook Pro、系统最高 Monterey 来写）。一个 Node 进程，没有图片处理的原生编译依赖。

## 在这台电脑上先跑起来

需要 Node.js。旧 Mac 请安装 **Node.js 22 LTS**（安装包选 macOS `.pkg`）。

不要安装 Node.js 24。24 的官方安装包要求 macOS 13.5，2015 款 MacBook Pro 最高只能升到 Monterey（12），装不上。Node.js 22 的安装包仍支持 macOS 11 及以上，Monterey 可以用。18 和 20 也能跑这个程序，但 20 已经停止维护。

```bash
node -v
```

应显示 `v22` 开头。然后：

```bash
cd family-media
npm install
npm start
```

`npm install` 几乎是空的，没有第三方运行库。终端里会打印两个地址：

- 电脑自己打开：`http://127.0.0.1:4721`
- 手机连上同一个 Wi-Fi 后打开：`http://192.168.x.x:4721`（以终端里印出来的为准）

手机浏览器直接输入这个地址。是 `http`，不是 `https`。先不用改任何配置，示例照片和一段短视频已经能看。

停掉前台服务：在那个终端按 `Ctrl+C`。

## 换成自己的照片

在项目目录里：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
MEDIA_DIR=/Users/你的用户名/Pictures/家人
```

`PHOTOS_DIR` 也可以，两个都写时用 `MEDIA_DIR`。路径可以是绝对路径。改完要重启服务。

手机先看到 3 个相册封面。下面有「加载更多」，点一次再拿 3 个。没有了就收起按钮，并写「没有更多了」。封面和张数来自 `cache/` 里的小索引，不会为了首页去读每一张原图，封面图也放在 `cache/`，不写进照片文件夹。封面是缩小后的图：赞和留言最多的那张；都没有的话，用拍摄最早的那张。点进相册才加载里面的照片。

- 普通照片和视频放在文件夹里，或放进随便起的子文件夹。页面按拍摄月份分成相册，比如 `2026年10月`。日期用照片里的拍摄日期，没有的话用文件修改时间。
- 特别的日子单独成册。把照片放进名为 `满月`、`100天`、`6个月`、`周岁` 的文件夹。也可以在任意文件夹里放 `album.json`：

```json
{ "occasion": true, "title": "第一次走路" }
```

这些照片不会再重复出现在月份里。

喜欢和留言写在这张照片旁边的 `comments` 文件夹里，文件名和照片一样。比如 `小自行车.jpg` 对应 `comments/小自行车.json`。换电脑时和照片一起拷走。

支持的照片：`.jpg` `.jpeg` `.png` `.gif` `.webp` `.heic` `.heif` `.tif` `.tiff` `.bmp`  
支持的视频：`.mp4` `.mov` `.m4v` `.webm`  
建议视频用 `.mp4` 或 iPhone 的 `.mov`，手机浏览器最稳。

实况照片要本来就带一小段动态，不会用静止的照片去编一段。iPhone 导出的原片一般是同名的一张照片加一段短视频，例如 `IMG_0001.HEIC` 和 `IMG_0001.MOV`（也可以是 `.JPG` 配 `.MOV` / `.MP4`）。认得出是实况的时候（视频里有苹果的 content identifier 或 still-image-time，两边的编号一致，或者照片自己标了实况编号并且旁边就是那段短视频），相册里只显示这张照片。看大图时可以点「播放实况」，播完回到照片。普通照片没有这个按钮。同名、但没有实况标记的长视频仍当作普通视频，不会藏起来。照片文件末尾已经嵌了动态（Motion Photo）时，也同样能点开播放。

排序用照片里的拍摄日期（JPEG），没有的话用文件修改时间，新的在前面。

照片放在项目外面，用 `MEDIA_DIR` 指过去。不要把家里的照片放进 git。

## 缩略图

格子里用的是缩小的图。点开照片时，先用这张小图垫着，再显示缓存里的屏幕尺寸图（最长边默认 1920），不再等整张原图下载完。原文件还在这台 Mac 上。视频仍是原文件，分段传输，不会整段读进内存。

照片里如果有定位，看大图时日期后面会补上查到的中文地址，比如「上海市黄浦区人民大道120号人民广场」。查不到，或者当时连不上，就只留日期，不显示经纬度。同一个地点只查一次，结果记在 `cache/` 里。

生成方式：

- 照片：Mac 自带的 `sips`（不用另装）
- 视频封面：如果装了 `ffmpeg`，会截一帧做封面。没装也能播放，只是格子里是一块深色的「视频」标记
- 生成结果在 `cache/`。第一次打开会慢一点，尤其是旧电脑。之后会直接用缓存。可以删掉 `cache/` 让它重做，不要把 `cache/` 提交到 git

Intel Mac 上如果 Homebrew 已经装不了新包，可以从 [ffmpeg.org/download.html](https://ffmpeg.org/download.html) 或 [evermeet.cx/ffmpeg](https://evermeet.cx/ffmpeg/) 下 macOS 静态包，把 `ffmpeg` 放到 `/usr/local/bin`。

iPhone 默认可能是 HEIC。Mac 上的 `sips` 能转成给浏览器看的 JPEG。如果某张一直出不来，用「预览」导出成 JPEG，或把相机格式改成「兼容性最佳」。

## 手机打不开时

- 手机和 Mac 是不是同一个 Wi-Fi。访客网络经常会把设备隔开
- 终端里的地址有没有变。Mac 重新连网后 IP 可能变，看一眼新打印的地址
- `.env` 里 `HOST` 要是 `0.0.0.0`。如果是 `127.0.0.1`，只有电脑自己能开
- 防火墙：Monterey 在「系统偏好设置 → 安全性与隐私 → 防火墙」。允许 `node` 的传入连接
- 让 Mac 别睡：接上电源。「系统偏好设置 → 节能」，电源适配器下勾上防止睡眠。合盖通常会睡，这台机器就开着盖子放着

## 一直开着

照片目录写在项目里的 `.env`，PM2 和下面的开机启动都会读到它。

### PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

最后一条会再打印一行命令，按它提示的再执行一次，登录后才会自动拉起。

```bash
pm2 status
pm2 logs family-media
pm2 restart family-media
pm2 stop family-media
```

### 开机启动（launchd）

适合不想装 PM2 的时候。编辑 `launchd/com.family.media.plist`：

- 把两处 `/Users/YOU/family-media` 换成项目实际路径
- 把 `/usr/local/bin/node` 换成 `which node` 的结果（官方安装包一般就是 `/usr/local/bin/node`）

然后：

```bash
cp launchd/com.family.media.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.family.media.plist
```

日志在 `/tmp/family-media.out.log` 和 `/tmp/family-media.err.log`。停掉：

```bash
launchctl unload ~/Library/LaunchAgents/com.family.media.plist
```

PM2 和 launchd 二选一，不要两个一起管同一个端口。

## 可选的查看码

家里 Wi-Fi 上默认谁都能看。如果想加一道，在 `.env` 里写：

```bash
ACCESS_CODE=家里
```

重启后，手机先输入这个查看码。码不要用太简单的，也不要写进 git（`.env` 已经被忽略）。连续输错太多次会停几分钟。

## 换到另一台 Mac

那台也可以是旧 Intel Mac。

1. 安装 Node.js 22
2. 把整个项目文件夹拷过去。`cache/` 可以不拷，到了新电脑会重新生成
3. 照片文件夹也拷过去，或者仍放在原来的硬盘上
4. 改新电脑上的 `.env`，`MEDIA_DIR` 写成新路径
5. `npm install`，然后 `npm start`，用终端里的新地址
6. 如果之前用了 PM2 或 launchd，在新电脑上再设一次。plist 里的用户名和路径都要改

## 以后如果要写短故事

这一版只有照片和视频，没有日记页面。数据已经留了位置，不用推倒重做。

照片文件夹或某个日子的文件夹里可以放一个 `stories.json`（现在不会显示在页面上）：

```json
[
  {
    "date": "2026-08-01",
    "text": "今天自己骑过了院子。",
    "media": ["小自行车.jpg"]
  }
]
```

`media` 写照片的文件名。服务会把它收成：

```json
{ "date": "2026-08-01", "text": "今天自己骑过了院子。", "mediaIds": ["..."] }
```

接口在照片列表的 `stories` 数组里。页面上只留了一个隐藏的占位，不打扰看照片。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server/` | 本机服务：读目录、缩略图、视频分段、可选查看码 |
| `public/` | 手机上的页面 |
| `demo-media/` | 示例照片和视频 |
| `.env` | 你的照片路径和查看码，不进 git |
| `cache/` | 缩略图缓存，不进 git |
| `ecosystem.config.cjs` | PM2 |
| `launchd/com.family.media.plist` | 开机启动 |

端口默认 `4721`。被占用时在 `.env` 里改 `PORT`。
