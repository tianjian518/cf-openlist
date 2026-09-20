// Strm driver — 将底层网盘的视频文件以 .strm 文件形式暴露（.strm 内容为可播放直链 URL）
// 移植自 OpenList Go 版 drivers/strm。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { getEnvCtx } from "../../internal/model/db"
import { signWithSecret } from "../../pkg/sign"
import { goEncodePath } from "../../pkg/urlpath"
import { StrmAddition } from "./types"

interface RemoteTarget {
  driver: StorageDriver
  /** 该映射对应的存储对象（用于判断解析结果是否落在同一存储上） */
  storage: any
  /** 配置里的原始虚拟路径（Go 侧传给 fs.List 的 dst），如 `/移动/移动CAS/移动影视CAS` */
  virtualPath: string
  /**
   * 该映射在【挂载点内部的相对路径】，如 `/移动CAS/移动影视CAS`。
   *
   * 由 init 阶段一次性算出：`resolvePath(virtualPath).physical`。
   * 之所以要单独存，是因为底层驱动的 `list/get` 接收的是「存储内相对路径」，
   * 而 `paths` 配置给的是「完整虚拟路径」。
   */
  physical: string
}

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return "/" + right
  if (!right) return left
  return left + "/" + right
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx > 0 ? p.slice(0, idx) : "/"
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() || ""
}

function getPair(path: string): [string, string] {
  if (path.includes(":")) {
    const idx = path.indexOf(":")
    const k = path.slice(0, idx)
    const v = path.slice(idx + 1)
    if (!k.includes("/")) return [k, v]
  }
  const segs = path.split("/").filter(Boolean)
  return [segs[segs.length - 1] || path, path]
}

/**
 * 与 Go `(d *Strm) getRootAndPath` 等价。
 *
 *   func (d *Strm) getRootAndPath(path string) (string, string) {
 *     if d.autoFlatten { return d.oneKey, path }   // ← sub 保留【带前导 /】的原路径
 *     path = strings.TrimPrefix(path, "/")
 *     parts := strings.SplitN(path, "/", 2)
 *     if len(parts) == 1 { return parts[0], "" }
 *     return parts[0], parts[1]
 *   }
 *
 * ⚠️ **刻意偏离 Go 的 autoFlatten 分支（Go 那一支是坏的）**
 *
 * Go 的 autoFlatten 只在 `paths` 恰好 1 条时生效，此时它返回
 * `(oneKey, 完整请求路径)`，而 `list()` 会做 `Join(dst, sub)`：
 *
 *   paths = "/移动/移动CAS"（单条）→ oneKey="移动CAS", autoFlatten=true
 *   List("/移动CAS")            → Join("/移动/移动CAS", "/移动CAS")
 *                               = "/移动/移动CAS/移动CAS"      ← 多出一层！
 *   List("/移动CAS/移动影视CAS") → Join("/移动/移动CAS", "/移动CAS/移动影视CAS")
 *                               = "/移动/移动CAS/移动CAS/移动影视CAS"  ← 灾难
 *
 * 实测（Go 程序验证）确认：**Go 的单路径 autoFlatten 是一个从未被验证过的
 * 死分支**。用户 139cas 的 `paths` 有 6 条 → `autoFlatten=false`，永远走不到，
 * 所以这个 bug 一直没暴露。而 CF 版只挂载了一个存储（`/移动`），`paths` 天然
 * 只能写 1 条 → 必然落进这个坏分支 → `.strm` 里出现重复的 `移动CAS` 层级 →
 * 爆米花拿到的播放地址是错的。
 *
 * 这里让自动展平等价于「非展平」语义（root 仍取 mapping key、sub 取 key 之后
 * 的相对子路径、根目录仍走 listRoot），使 CF 单路径配置的行为与 Go 的
 * 多路径配置**完全一致** —— 这才符合用户「换任何配置都不能崩」的要求。
 */
export function getRootAndPath(
  path: string,
  autoFlatten = false,
  oneKey = "",
): [string, string] {
  if (autoFlatten) {
    /**
     * 单条 paths 时 pathMap 形如 `{ "移动": ["/移动"] }`：
     *   - key  = 路径最后一段（这里是「移动」），也是展开后列表里显示的名字
     *   - root 恒为 oneKey（唯一映射），无需从请求路径里推断
     *   - sub  = 请求路径**里 key 之后**的相对部分
     *
     * ⚠️ 曾经的 BUG（线上表现为「STRM 下平白多出一层同名目录」）：
     *
     *   const idx = full.indexOf("/")
     *   if (idx < 0) return [oneKey, ""]        // ← 把整段 full 丢掉了
     *
     * 当 `full` 不含斜杠时（如 List("/移动CAS")），上面的写法直接返回空 sub，
     * 于是 list() 里去 Join("/移动", "") = "/移动" —— **列的是根目录**。
     * 用户点「移动CAS」看到的还是根目录里的 `cas600t/移动影视CAS`……
     * 不对，看到的是根目录里那几个目录，于是再点一次「移动CAS」才轮到
     * 「移动CAS/移动CAS」这种双写路径命中正确层级，表现为"两层相同目录"。
     *
     * 正确语义：**只要 full 不等于 oneKey，full 整体就是 sub**。
     * 剥掉的是与 oneKey 同名的那一段，而不是"到第一个斜杠为止"那一段。
     */
    const full = String(path || "/")
      .split("/")
      .filter(Boolean)
      .join("/") // 规范化：去前导/重复斜杠
    if (!full) return [oneKey, ""]

    const parts = full.split("/")
    // full 以 oneKey 开头（用户在列表里点进来的正常路径）→ 剥掉这一段
    if (parts[0] === oneKey) {
      return [oneKey, parts.slice(1).join("/")]
    }
    // 不以 oneKey 开头：整段都是子路径。例如 paths="/移动" 时请求
    // "/移动CAS"，oneKey="移动" 不是前缀，sub 必须保留成 "移动CAS"，
    // 否则会退回根目录（历史 BUG）。
    return [oneKey, full]
  }
  const p = String(path || "").split("/").filter(Boolean).join("/")
  const idx = p.indexOf("/")
  if (idx < 0) return [p, ""]
  return [p.slice(0, idx), p.slice(idx + 1)]
}

export class StrmDriver implements StorageDriver {
  private addition: StrmAddition
  private pathMap = new Map<string, string[]>()
  private remotes = new Map<string, RemoteTarget>()
  private supportSuffix = new Set<string>()
  private downloadSuffix = new Set<string>()
  private autoFlatten = false
  private oneKey = ""

  constructor(addition: StrmAddition) {
    this.addition = addition || {}
  }

  async init(): Promise<void> {
    const paths = this.addition.paths || ""
    if (!paths.trim()) throw new Error("[Strm] paths is required")

    for (const raw of paths.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      const [k, v] = getPair(line)
      if (!this.pathMap.has(k)) this.pathMap.set(k, [])
      this.pathMap.get(k)!.push(v)
    }
    if (this.pathMap.size === 1) {
      this.autoFlatten = true
      this.oneKey = this.pathMap.keys().next().value ?? ""
    }

    const supportTypes = (
      this.addition.filterFileTypes ||
      "mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac"
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    this.supportSuffix = new Set(supportTypes)

    const downloadTypes = (
      this.addition.downloadFileTypes || "ass,srt,vtt,sub,strm"
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    this.downloadSuffix = new Set(downloadTypes)

    // ── 对齐 Go `if d.Version != 5 { ... }` 的迁移逻辑 ──────────────────
    //
    // Go 的这段是**向后兼容**：老配置（Version < 5）没有完整扩展名列表，
    // 也不一定有 PathPrefix，于是 Init 时补齐默认值并把 Version 置 5。
    //
    //   types := strings.SplitSeq("mp4,mkv,...,alac", ",")
    //   for ext := range types {
    //     if _, ok := d.supportSuffix[ext]; !ok {
    //       d.supportSuffix[ext] = struct{}{}
    //       supportTypes = append(supportTypes, ext)
    //     }
    //   }
    //   d.FilterFileTypes = strings.Join(supportTypes, ",")
    //   ... 同理补 DownloadFileTypes ...
    //   d.PathPrefix = "/d"
    //   d.Version = 5
    //
    // 意义：用户从旧版升级、或分享配置给网友时，即使 paths/扩展名列表不全，
    // 也能得到与新版一致的行为（否则 `.strm` 里会缺 `/d` 前缀而全部播不了）。
    if (Number(this.addition.Version) !== 5) {
      const DEFAULT_FILTER =
        "mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac"
      const DEFAULT_DOWNLOAD = "ass,srt,vtt,sub,strm"
      for (const ext of DEFAULT_FILTER.split(",")) {
        const e = ext.trim().toLowerCase()
        if (e && !this.supportSuffix.has(e)) {
          this.supportSuffix.add(e)
          supportTypes.push(e)
        }
      }
      for (const ext of DEFAULT_DOWNLOAD.split(",")) {
        const e = ext.trim().toLowerCase()
        if (e && !this.downloadSuffix.has(e)) {
          this.downloadSuffix.add(e)
          downloadTypes.push(e)
        }
      }
      this.addition.filterFileTypes = supportTypes.join(",")
      this.addition.downloadFileTypes = downloadTypes.join(",")
      if (!this.addition.PathPrefix) this.addition.PathPrefix = "/d"
      this.addition.Version = 5
    }

    // 预解析底层 storage（动态 import 避免循环依赖）
    const { resolvePath } = await import("../../internal/model/db")
    const { getDriver } = await import("../../internal/op/storage")
    for (const dsts of this.pathMap.values()) {
      for (const dst of dsts) {
        try {
          const resolved = await resolvePath(dst)
          if (!resolved.isVirtual && resolved.storage) {
            const driver = await getDriver(
              resolved.storage.driver,
              resolved.storage,
              this.siteBaseUrl || undefined,
            )
            this.remotes.set(dst, {
              driver,
              storage: resolved.storage,
              virtualPath: dst,
              physical: resolved.physical || "/",
            })
          }
        } catch (e) {
          console.warn(`[Strm] failed to resolve remote path '${dst}':`, e)
        }
      }
    }
  }

  /**
   * 与 Go `utils.EncodePath(path, true)` 完全等价 —— 按 `/` 切段，
   * 每段做 `url.PathEscape`。
   *
   * 此前用 `encodeURIComponent(seg)` 是**错的**：它会把 `$ & + , : ; = @`
   * 一并转义，而 Go `url.PathEscape` 保留这些子分隔符。
   * 结果是含 `+` / `:` / `,` 的文件名在两边生成不同的 URL。
   */
  private encodePath(path: string): string {
    return goEncodePath(path)
  }

  /**
   * 生成 strm 文件内容（要写入 .strm 的那一行 URL）。
   *
   * **严格对齐 Go `drivers/strm/util.go getLink`：**
   *
   *   func (d *Strm) getLink(ctx context.Context, path string) string {
   *     finalPath := path
   *     if d.EncodePath { finalPath = utils.EncodePath(path, true) }
   *     if d.WithSign {
   *       signPath := sign.Sign(path)                       // ← 用【原始】path 签名
   *       finalPath = fmt.Sprintf("%s?sign=%s", finalPath, signPath)
   *     }
   *     pathPrefix := d.PathPrefix
   *     if len(pathPrefix) > 0 { finalPath = stdpath.Join(pathPrefix, finalPath) }
   *     if !strings.HasPrefix(finalPath, "/") { finalPath = "/" + finalPath }
   *     if d.WithoutUrl { return finalPath }
   *     apiUrl := d.SiteUrl ...
   *     return fmt.Sprintf("%s%s", apiUrl, finalPath)
   *   }
   *
   * 关键点（此前 TS 版缺失，导致 `withSign:true` 形同虚设）：
   *   1. `withSign` 开关此前完全没被读取 —— 用户配了 true 也不生成签名；
   *   2. 签名对象是**未编码的原始 path**（`sign.Sign(path)`），
   *      而 URL 中展示的是**编码后**的 path，二者不可混用；
   *   3. 签名查询串拼在 PathPrefix 之前，编码发生在签名之前。
   *
   * `withSign` 为 true 时使用 `sign_all` 语义：expire 取 link_expiration，
   * 为 0 则**永不过期**（Go `NotExpired`），与非零配置一致。
   */
  private async getLink(path: string): Promise<string> {
    let finalPath = path
    // ── 路径**无条件**编码（`encodePath` 配置项已废弃）────────────────────
    //
    // 【为什么必须编码】
    // `.strm` 是一行纯文本，播放器（网易爆米花 / Emby / Kodi / Infuse）拿到后
    // 是**照字面**去请求的，不会替我们做转义。而片名里空格、`()[]{}` 几乎必然
    // 存在，例如：
    //
    //   .../华语电影/喜宴 (1993) {tmdb-9261}/喜宴 (1993) {tmdb-9261} [1080p H.265 DD 2.0].mkv.cas
    //
    // 含裸空格与花括号的 URL 属于**非法 URI**，播放器在解析阶段就失败，
    // 用户看到的现象正是「WebDAV 地址不对 / 打不开」。实测同一路径：
    // 未编码时 curl 直接拒绝发送；编码后 HTTP 200，签名校验同样通过
    // （验签侧 `reqPath` 来自 Hono 已解码的路径，两边一致）。
    //
    // 【为什么不再看配置】
    // 此处原先按 `this.addition.encodePath` 开关决定，有三个致命问题：
    //
    //   1. 该开关取 false 时**必然产出非法 URL**，不存在任何合法用途 ——
    //      它不是"特性"，而是"关掉之后全是坏链"的陷阱。Go 版保留它只为
    //      向后兼容，官方前端默认勾选。
    //   2. 判定式曾是 `=== true` 语义（truthy），字段为 undefined（旧配置
    //      从未写过该项）时走不编码分支 → **沉默的、逐文件发作的坏链**：
    //      只有片名含空格的文件打不开，其余正常，极难归因到配置。
    //   3. 线上排查时发现该值经 isolate 缓存传播，改动后不同边缘节点
    //      读数不一致，同一文件**时而编码时而裸 URL**（实测 8 次取样 6:2）。
    //      靠配置控制意味着修复生效时间不可控。
    //
    // 结论：编码是**正确性要求**，不是可选项 —— 故无条件执行，忽略配置值。
    // 保留 `encodePath` 字段仅为兼容旧配置的读写，不再参与判断。
    finalPath = this.encodePath(path)

    // ── 对齐 Go：WithSign → sign.Sign(path) 后拼 ?sign= ──────────────────
    if (this.addition.withSign) {
      const sign = await this.signPath(path)
      finalPath = `${finalPath}?sign=${sign}`
    }

    const prefix = this.addition.PathPrefix || "/d"
    finalPath = joinPath(prefix, finalPath)
    if (!finalPath.startsWith("/")) finalPath = "/" + finalPath

    if (this.addition.withoutUrl) return finalPath
    // 对齐 Go `common.GetApiUrl(ctx)`：
    //   apiUrl := d.SiteUrl
    //   if len(apiUrl) > 0 { apiUrl = strings.TrimSuffix(apiUrl, "/") }
    //   else { apiUrl = common.GetApiUrl(ctx) }   // ← 用当前请求的站点地址
    //
    // 此前 TS 版 siteUrl 为空时直接拼出【相对路径】（如 `/d/xxx.cas?sign=...`），
    // 而 .strm 是独立文件，播放器/媒体库（网易爆米花、Emby、Kodi 等）无从
    // 推断这个相对路径属于哪个站点 → 无法播放。
    // 必须输出绝对 URL，否则 strm 形同废纸。
    const configured = (this.addition.siteUrl || "").replace(/\/+$/, "")
    const apiUrl = configured || this.resolvedSiteUrl()
    if (!apiUrl) {
      // 兜底：真正的空 origin 会让 `.strm` 内容退化成相对路径（`/d/...`），
      // 播放器无从推断站点 → 必然「WebDAV 地址错误」。此时宁可打日志暴露，
      // 也不要静默产出坏链。
      console.warn(
        `[Strm] getLink: 站点基准地址为空，将产出相对路径 '${finalPath}'`,
      )
      return finalPath
    }
    return `${apiUrl}${finalPath}`
  }

  /**
   * 站点基准地址（绝对 URL 前缀）。
   *
   * ⚠️ **这是实例级可变字段，而驱动实例被 `driverCache` 按 `id_modified`
   * 跨请求复用** —— 多个并发请求会共享同一个值。因此：
   *
   *   1. 每次写入都带 `siteBaseUrlAt` 时间戳，`resolvedSiteUrl()` 只认
   *      「新鲜」的值，避免某次请求拿到很久以前另一个请求写下的陈旧 origin；
   *   2. 传入空值时必须**清空**而不是忽略，否则某次解析失败会把这个错值
   *      「粘」在实例上直到 isolate 回收（这正是「时好时坏、坏一阵子又自己
   *      好了」的来源）；
   *   3. 最终仍取不到时回退到本次请求的 origin（`env.__requestOrigin`）。
   */
  private siteBaseUrl = ""
  private siteBaseUrlAt = 0
  /** 站点基准地址的有效期：远超任何单次请求的生命周期，
   *  仅用于淘汰「上一个 isolate 生命周期遗留」的陈旧值。 */
  private static readonly SITE_URL_TTL_MS = 10 * 60 * 1000

  setSiteBaseUrl(url: string): void {
    this.siteBaseUrl = String(url || "").replace(/\/+$/, "")
    this.siteBaseUrlAt = Date.now()
  }

  private resolvedSiteUrl(): string {
    const fresh =
      this.siteBaseUrl && Date.now() - this.siteBaseUrlAt < StrmDriver.SITE_URL_TTL_MS
    if (fresh) return this.siteBaseUrl
    // 回退：本次请求中间件写入的 origin（index.ts 每请求无条件刷新）。
    try {
      const envOrigin = getEnvCtx?.()?.__requestOrigin
      if (envOrigin) return String(envOrigin).replace(/\/+$/, "")
    } catch {
      // 忽略：拿不到就交给调用方兜底
    }
    return ""
  }

  /**
   * 对给定路径签名，输出 Go 格式 `base64url(hmac):expire`。
   *
   * expire 取值对齐 Go `internal/sign.Sign`：
   *   expire := setting.GetInt(conf.LinkExpiration, 0)
   *   if expire == 0 { return NotExpired(data) }        // expire=0，永不过期
   *   else { return WithDuration(data, expire * time.Hour) }
   *
   * 注意 Go 的 `link_expiration` 单位是**小时**（`time.Hour`），
   * 此处保持同样语义。secret 复用站点 Token（TS 侧 getJwtSecret）。
   */
  private signSecret?: string
  private linkExpirationHours?: number

  setSignContext(secret?: string, linkExpirationHours?: number): void {
    if (secret !== undefined) this.signSecret = secret
    if (linkExpirationHours !== undefined) {
      this.linkExpirationHours = linkExpirationHours
    }
  }

  private async signPath(path: string): Promise<string> {
    const secret = this.signSecret || ""
    const hours = Number(this.linkExpirationHours) || 0
    // Go：expire == 0 → 永不过期（时间戳写 0）
    const expire =
      hours > 0 ? Math.floor(Date.now() / 1000) + hours * 3600 : 0
    return signWithSecret(secret, path, expire)
  }

  /**
   * 与 Go `utils.SourceExt(name)` 等价：
   *   ext := path.Ext(name); if len(ext) > 0 && ext[0] == '.' { ext = ext[1:] }
   * 返回**不含点**的扩展名（Go 侧大小写原样，调用方再 ToLower）。
   *
   * 与 JS 直觉的差异（之前用 `lastIndexOf(".")` 的写法会跑偏）：
   *   `.gitignore`   → Go: "gitignore"（无扩展名判断按整名切）  JS 直觉: "gitignore"
   *   `无扩展名`      → Go: ""                        JS 直觉: ""
   *   `a.b.c`        → Go: "c"                       JS 直觉: "c"
   */
  private sourceExt(name: string): string {
    const idx = name.lastIndexOf(".")
    // Go 的 path.Ext 对 `.gitignore`（唯一点且在首位）**也**返回 ".gitignore"，
    // 因为 path.Ext 的规则是「最后一个 '.' 及其后缀」，不排除首字符。
    return idx >= 0 ? name.slice(idx + 1) : ""
  }

  /**
   * 与 Go `strings.TrimSuffix(s, suffix)` 等价。
   * `sourceExt === ""` 时 Go 的 TrimSuffix 是**空操作**（不会误删结尾），
   * JS 的 `replace(/\.[^.]+$/,"")` 却可能删掉点号结尾，故单独实现。
   */
  private trimSuffix(s: string, suffix: string): string {
    if (!suffix) return s
    return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s
  }

  /**
   * 列出远端目录内容。
   *
   * **与 Go `(d *Strm) list` 严格对齐：**
   *
   *   func (d *Strm) list(ctx context.Context, dst, sub string, args *fs.ListArgs) ([]model.Obj, error) {
   *     reqPath := stdpath.Join(dst, sub)     // ← dst 是【配置里的原始虚拟路径】
   *     objs, err := fs.List(ctx, reqPath, args)
   *     ...
   *   }
   *
   * 关键：Go 把 `dst`（如 `/移动/移动CAS/移动影视CAS`，**带挂载点**）与 `sub`
   * 拼成**完整虚拟路径**后交给 `fs.List`，由 fs 层自己去解析挂载点。
   *
   * 此前 CF 版错误地使用 `resolvePath(dst).physical`（**已剥离挂载点**的相对
   * 路径，如 `/移动CAS/移动影视CAS`）来拼接，一旦用户修改 `paths` 导致挂载点
   * 层级变化，拼出来的路径就会落到错误的存储位置 —— 表现为「改配置就崩」。
   * 这里改为与 Go 一致：拼完整虚拟路径，交给 op 层解析。
   */
  private async listRemote(dst: string, sub: string): Promise<FileItem[]> {
    const remote = this.remotes.get(dst)
    if (!remote) return []
    // `physical` 是该映射在存储内部的相对路径（init 阶段算好），
    // `sub` 是挂载点之后的子路径，两者拼接即底层驱动认识的路径。
    const remotePath = joinPath(remote.physical, sub)
    try {
      // ⚠️ 必须给底层驱动补注入运行时上下文。
      //
      // `injectRuntimeContext` 是在 `getDriver()` 的**调用点**执行的，只作用于
      // 当前请求拿到的那个驱动（这里是 strm 自己）。strm 在 init 里**内部**
      // 又调了一次 `getDriver()` 拿到 139 驱动实例，那次调用没有经过注入，
      // 于是 139 驱动的 `storageId` / `envCtx` 恒为 undefined。
      //
      // 后果（实测）：139 的直链/目录缓存拿不到 storageId → 缓存键的存储隔离
      // 退化；更致命的是拿不到 env → 缓存**永远写不进 KV**（`getBinding`
      // 返回 null）→ 只剩进程内 Map，而 isolate 会在 AMS/LHR 之间漂移，
      // 内存命中率极低 → 优化形同虚设，播放仍然卡 2~14 秒。
      const t = remote.driver as any
      if (typeof t.setRuntimeContext === "function") {
        try {
          // env 取全局注入的：index.ts 中间件每请求都会 `setEnvCtx(env)`，
          // 这是最可靠的来源（storage 对象上并不携带 env）。
          const mod: any = await import("../../internal/model/db")
          t.setRuntimeContext({
            storageId: (remote.storage as any)?.id,
            env: mod.getEnvCtx?.(),
          })
        } catch {
          /* 注入失败不影响主流程，缓存会退化为纯内存 */
        }
      }
      return await remote.driver.list("", remotePath)
    } catch (e: any) {
      // ⚠️ 不能静默吞异常。返回空数组会让上层认为「目录里没这个文件」，
      // 于是 `strmContent()` 返回 null，请求落到 `/p` 302 代理分支 ——
      // 播放器看到的是一个 302 而非 `.strm` 文本内容，现象就是
      // 「WebDAV 地址错误」。而底层网盘偶发超时/限流正属此类，
      // 这解释了**同一集时而能播、时而报错**。
      // 这里打日志保留可观测性，返回值仍与 Go 一致（空列表）。
      console.warn(
        `[Strm] listRemote failed for dst='${dst}' path='${remotePath}':`,
        e?.message || e,
      )
      return []
    }
  }

  private async convert(
    reqPath: string,
    items: FileItem[],
  ): Promise<FileItem[]> {
    const result: FileItem[] = []
    for (const item of items) {
      if (item.is_dir) {
        result.push(item)
        continue
      }
      const sourceExt = this.sourceExt(item.name)
      const e = sourceExt.toLowerCase()
      const originalPath = joinPath(reqPath, item.name)
      if (this.downloadSuffix.has(e)) {
        result.push({ ...item, size: item.size })
      } else if (this.supportSuffix.has(e)) {
        // 对齐 Go：`name = strings.TrimSuffix(name, sourceExt) + "strm"`
        // 注意 Go 的 sourceExt 是**不带点**的扩展名，TrimSuffix 后没有点，
        // 于是直接拼 "strm"。之前写成 `replace(/\.[^.]+$/,"") + ".strm"`
        // 结果虽然一致，但无扩展名（sourceExt === ""）时 TrimSuffix 是空操作、
        // 会拼出 `name + "strm"`，与 JS 版行为不同。
        const strmName = this.trimSuffix(item.name, sourceExt) + "strm"
        const strmUrl = await this.getLink(originalPath)
        result.push({
          name: strmName,
          size: new TextEncoder().encode(strmUrl).length,
          is_dir: false,
          modified: item.modified,
          sign: originalPath, // 保存原始路径，供 get/createReadStream 还原
          thumb: item.thumb || "",
          type: calcFileType(strmName, false),
          raw_url: "",
        })
      }
      // 其他类型跳过
    }
    return result
  }

  async list(_v: string, physicalPath: string): Promise<FileItem[]> {
    const path = physicalPath || "/"
    // 对齐 Go `if utils.PathEqual(path,"/") && !d.autoFlatten { return d.listRoot() }`。
    //
    // ⚠️ 偏离点：Go 在 autoFlatten 时**跳过** listRoot，直接走 getRootAndPath，
    // 而那条路是坏的（见 getRootAndPath 注释）。这里改为**无论展平与否都返回
    // listRoot**，使单路径配置的根目录也能列出映射名（`移动CAS`），与 Go
    // 多路径配置的表现一致。
    if (path === "/" || path === "") {
      const items: FileItem[] = []
      for (const k of this.pathMap.keys()) {
        items.push({
          name: k,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        })
      }
      return items
    }

    const [root, sub] = getRootAndPath(path, this.autoFlatten, this.oneKey)

    const dsts = this.pathMap.get(root)
    // 对齐 Go `List`：
    //   dsts, ok := d.pathMap[root]
    //   if !ok { return nil, errs.ObjectNotFound }
    // key 不存在时 Go 返回「未找到」而不是崩溃。此处返回空列表，
    // 让上层表现为「空文件夹」，与 Go 的 ObjectNotFound 在 UI 上等价，
    // 且不会把整个列表请求打成 500（此前会抛错，导致 /strm/任意乱路径 直接报错）。
    if (!dsts) return []

    const merged: FileItem[] = []
    const seen = new Set<string>()
    for (const dst of dsts) {
      const remote = this.remotes.get(dst)
      if (!remote) continue
      const reqPath = joinPath(dst, sub)
      const items = await this.listRemote(dst, sub)
      for (const converted of await this.convert(reqPath, items)) {
        if (!seen.has(converted.name)) {
          seen.add(converted.name)
          merged.push(converted)
        }
      }
    }
    return sortFileItems(merged, "name", "asc")
  }

  /**
   * 与 Go `(d *Strm) Get` **严格同序**（顺序本身就是语义）：
   *
   *   func (d *Strm) Get(ctx, path) (model.Obj, error) {
   *     root, sub := d.getRootAndPath(path)
   *     dsts, ok := d.pathMap[root]
   *     if !ok { return nil, errs.ObjectNotFound }
   *     for _, dst := range dsts {
   *       reqPath := stdpath.Join(dst, sub)
   *       obj, err := fs.Get(ctx, reqPath, &fs.GetArgs{NoLog: true})   // ① 先查底层真实文件
   *       if err != nil { continue }
   *       size := int64(0)
   *       if !obj.IsDir() { size = obj.GetSize(); path = reqPath }     // ② 命中真实文件
   *       return &model.Object{Path: path, Name: obj.GetName(), Size: size, ...}, nil
   *     }
   *     if strings.HasSuffix(path, ".strm") { return nil, errs.NotSupport }  // ③ 交给上层走 List
   *     return nil, errs.ObjectNotFound
   *   }
   *
   * ⚠️ 顺序至关重要：Go **先查底层真实文件**，只有全部失败才认为它是虚拟 `.strm`。
   * 此前 CF 版反过来先判 `.strm` 后缀，会让本该命中的真实文件走错分支。
   */
  async get(_v: string, physicalPath: string): Promise<FileItem> {
    const path = physicalPath || "/"

    // ① 先查底层真实文件（对齐 Go `fs.Get(dst+sub)`）
    const [root, sub] = getRootAndPath(path, this.autoFlatten, this.oneKey)
    const dsts = this.pathMap.get(root) || []
    for (const dst of dsts) {
      const remote = this.remotes.get(dst)
      if (!remote) continue
      const remotePath = joinPath(remote.physical, sub)
      try {
        const item = await remote.driver.get("", remotePath)
        if (item) {
          // 对齐 Go `model.Object.Path`：把**虚拟路径**回填到条目上。
          // strm 的 `linkUrl()` 需要用它拼 `/p{EncodePath(virtualPath)}`，
          // 与 Go `Link` 分支 ③ 里 `file.GetPath()` 的语义一致。
          return { ...item, path }
        }
      } catch {
        // 尝试下一个映射
      }
    }

    // ② 底层没找到：以 `.strm` 结尾则从（虚拟）列表里找
    if (path.endsWith(".strm")) {
      const dir = dirname(path)
      const name = basename(path)
      const items = await this.list("", dir)
      const item = items.find((i) => i.name === name)
      if (!item) throw new Error(`[Strm] not found: ${path}`)
      return item
    }
    throw new Error(`[Strm] not found: ${path}`)
  }

  async mkdir(): Promise<void> {
    throw new Error("[Strm] mkdir is not supported")
  }
  async rename(): Promise<void> {
    throw new Error("[Strm] rename is not supported")
  }
  async remove(): Promise<void> {
    throw new Error("[Strm] remove is not supported")
  }
  async move(): Promise<void> {
    throw new Error("[Strm] move is not supported")
  }
  async copy(): Promise<void> {
    throw new Error("[Strm] copy is not supported")
  }
  async put(): Promise<void> {
    throw new Error("[Strm] put is not supported")
  }

  /**
   * 取虚拟 `.strm` 文件的**文本内容**（即那行播放 URL）。
   *
   * 对齐 Go `(d *Strm) Link` 的**分支 ①**：
   *
   *   if file.GetID() == "strm" {
   *     link := d.getLink(ctx, file.GetPath())
   *     return &model.Link{RangeReader: strings.NewReader(link)}, nil
   *   }
   *
   * 虚拟 `.strm` 不是真实字节流，它唯一的意义就是「内容是一行 URL」。
   * 因此 `/p/xxx.strm` 与 `/dav/xxx.strm` 都必须**直接返回这行文本**，
   * 而不能 302 到自身（那会自指死循环 + 签名校验失败 → 401）。
   *
   * 返回 `null` 表示该路径不是有效的虚拟 `.strm`（调用方应回退到其它分支）。
   */
  /**
   * ⚠️ 不能用 `this.list()` 的返回值来找真实路径：`op` 层会把条目的
   * `sign` 字段**覆盖成下载签名**（见 webdav driver 的同款注释），
   * 驱动内部 `convert()` 存进去的原始路径会被冲掉。
   * 因此这里直接查**底层真实文件**，按 convert() 的逆规则匹配虚拟名。
   *
   * 参数 `physicalPath` 是**存储内相对路径**（如 `/移动CAS/.../x.mp4.strm`），
   * 与 `list()`/`get()` 的第二个参数同一语义（op 层传的是 `resolved.physical`）。
   */
  async strmContent(physicalPath: string): Promise<string | null> {
    const path = physicalPath || "/"
    if (!path.endsWith(".strm")) return null
    const dir = dirname(path)
    const name = basename(path)
    const [root, sub] = getRootAndPath(path, this.autoFlatten, this.oneKey)
    const dsts = this.pathMap.get(root) || []
    for (const dst of dsts) {
      const rawItems = await this.listRemote(dst, dirname(sub))
      for (const raw of rawItems) {
        if (raw.is_dir) continue
        const ext = this.sourceExt(raw.name).toLowerCase()
        // 只考虑会被 convert() 转成 .strm 的那类文件
        // （supportSuffix 命中且非 downloadSuffix）
        if (!this.supportSuffix.has(ext) || this.downloadSuffix.has(ext)) continue
        const virtualName =
          this.trimSuffix(raw.name, this.sourceExt(raw.name)) + "strm"
        if (virtualName !== name) continue
        // 命中：用**与 list() 一致的虚拟路径格式**生成播放 URL。
        // list() 用的是 `joinPath(dst, sub)`（dst 为配置里的路径），
        // 这里同样以 dst 打底拼真实文件名，保证签名对象两边完全一致。
        const realPath = joinPath(dst, joinPath(dirname(sub), raw.name))
        return await this.getLink(realPath)
      }
    }
    return null
  }

  /** .strm 文件内容：可播放直链 URL */
  async createReadStream(
    physicalPath: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const path = physicalPath || "/"
    const dir = dirname(path)
    const name = basename(path)
    const items = await this.list("", dir)
    const item = items.find((i) => i.name === name)
    if (!item || !item.sign) throw new Error(`[Strm] not found: ${path}`)
    const link = await this.getLink(item.sign)
    const bytes = new TextEncoder().encode(link)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  /**
   * 与 Go `(d *Strm) Link` 对齐 —— 返回真实文件（`.cas` / `.mkv` 等）的下载地址。
   *
   *   func (d *Strm) Link(ctx, file, args) (*model.Link, error) {
   *     if file.GetID() == "strm" {                       // ① 虚拟 .strm 文件
   *       link := d.getLink(ctx, file.GetPath())
   *       return &model.Link{RangeReader: ...}, nil       //    → 内容就是那行 URL
   *     }
   *     if common.GetApiUrl(ctx) == "" { args.Redirect = false }
   *     reqPath := file.GetPath()
   *     link, _, err := d.link(ctx, reqPath, args)        // ② 查底层
   *     if err != nil { return nil, err }
   *     if link == nil {                                  // ③ 走代理
   *       return &model.Link{URL: fmt.Sprintf("%s/p%s?sign=%s",
   *         common.GetApiUrl(ctx),
   *         utils.EncodePath(reqPath, true),
   *         sign.Sign(reqPath))}, nil
   *     }
   *     resultLink := *link
   *     resultLink.SyncClosers = utils.NewSyncClosers(link)
   *     return &resultLink, nil
   *   }
   *
   * ⚠️ 分支 ③ 是 strm 驱动的**常态**：strm 的 Config 里 `OnlyProxy: true`
   * 使 `common.ShouldProxy()` **恒为 true**，于是 `d.link()` 永远返回
   * `(nil, obj, nil)` —— 即 `link == nil` 永远成立。
   *
   * 结论：**strm 驱动下，所有真实文件的下载地址恒为
   * `{apiUrl}/p{EncodePath(path,true)}?sign={sign(path)}`（代理地址），
   * 而不是底层驱动给出的 CDN 直链。**
   */
  async linkUrl(virtualPath: string): Promise<string> {
    const reqPath = virtualPath.startsWith("/") ? virtualPath : "/" + virtualPath
    const encoded = goEncodePath(reqPath)
    const sign = await this.signPath(reqPath)
    const configured = (this.addition.siteUrl || "").replace(/\/+$/, "")
    const apiUrl = configured || this.resolvedSiteUrl()
    return `${apiUrl}/p${encoded}?sign=${sign}`
  }
}
