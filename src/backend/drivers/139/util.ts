import CryptoJS from "crypto-js"
import {
  Yun139Addition,
  QueryRoutePolicyResp,
  Yun139DiskResp,
  Yun139DownloadResp,
  Yun139FileItem,
  Yun139StorageDetailsResp,
  PersonalListResp,
  PersonalDownloadResp,
  PersonalFileItem,
} from "./types"
import {
  getCachedLink,
  setCachedLink,
  getCachedList,
  setCachedList,
} from "./linkcache"

/**
 * 与官方 Go 实现 `url.QueryEscape` + 补充转义保持一致的编码。
 *
 * 关键：Go 的 `encodeURIComponent` 语义还转义 `!'()*`，
 * 而 JS 内置的 encodeURIComponent 不转义它们。签名是对"编码后的字符串"
 * 做排序再哈希，任何一个字符编码不一致都会导致签名校验失败。
 */
export function encodeURIComponentCustom(str: string): string {
  let r = encodeURIComponent(str)
  r = r.replace(/!/g, "%21")
  r = r.replace(/'/g, "%27")
  r = r.replace(/\(/g, "%28")
  r = r.replace(/\)/g, "%29")
  r = r.replace(/\*/g, "%2A")
  return r
}

export function md5(str: string): string {
  return CryptoJS.MD5(str).toString(CryptoJS.enc.Hex)
}

/**
 * 带超时的 `fetch`。
 *
 * ## 为什么必须加（真实故障）
 *
 * 139 的 API 偶发**完全不响应**，而原生 `fetch` 没有超时概念 —— 一旦卡住
 * 就只能等 CF 平台硬杀（90~120 秒）。线上表现为：
 *
 *   - `fs/get` / `PROPFIND` 打十次卡两三次，客户端 `http=000` 且耗时 90s+；
 *   - 同时段其它请求被拖慢，边缘节点还可能判定子请求配额超限 → 503；
 *   - 报错信息里**看不出是哪一步卡住**，只能看到"请求整体超时"。
 *
 * 加上超时后，卡死的单次往返会在 8 秒内失败并抛出明确错误，
 * 上层（driver / op）得以按自己的语义降级（例如退回逐层解析、返回 5xx
 * 并带上原因），而不是把整个请求耗到平台强杀。
 *
 * ## 实现说明
 *
 * 优先用 `AbortSignal.timeout()`（Workers 与 Node 18+ 均支持，最简洁）。
 * 若运行时不支持，则退化为手动 `AbortController` + `setTimeout`，
 * 并务必在 `finally` 里清掉计时器，避免长命 isolate 里计时器泄漏。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  // ⚠️ **必须用显式 AbortController + setTimeout，不能用 AbortSignal.timeout()**
  //
  // 实测（2026-09-18 线上）：`AbortSignal.timeout(8000)` 在 CF Workers 上
  // **不会触发** —— 139 API 卡死时请求照样挂到平台 95 秒硬杀，
  // 客户端看到整齐的 `http=000 t=95.0s`。换回手动 AbortController 后
  // 超时才真正生效（无需依赖运行时的 signal 实现细节）。
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      // 忽略：abort 失败不影响主流程
    }
  }, timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err: any) {
    // 把 abort 转成可读错误，避免上层只看到含糊的 "The operation was aborted"
    if (controller.signal.aborted) {
      throw new Error(
        `139 请求超时（${timeoutMs}ms，目标 ${url.slice(0, 80)}）`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给任意 Promise 套一层超时，超时抛错。
 *
 * ## 为什么需要它（真实故障根因）
 *
 * `fetchWithTimeout` 只保护到**响应头到达**为止 —— 一旦 `fetch()` resolve，
 * 它内部的计时器就在 `finally` 里被清掉了。但 `res.json()` / `res.text()`
 * 是**第二次 await**，读取 body 期间完全没有超时保护。
 *
 * 139 的 API 存在「响应头很快返回、body 却迟迟不结束」的情况（慢速传输 /
 * 连接半挂），此时 `await res.json()` 会一直等下去，直到 CF 平台在
 * **95 秒**左右硬杀请求。这也是实测中 `fs/list` 打 15 次卡死 3 次
 * （`http=000 t=95.000s`，耗时精确到毫秒整齐）的直接原因。
 *
 * 注意这里的超时**无法真正取消**底层的 body 读取（读 body 不受
 * AbortController 约束），但我们至少能**及时失败并降级**，
 * 不再把整个请求拖到平台超时 —— 对调用方而言这才是可用的行为。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = ""): Promise<T> {
  let timer: any
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`请求超时（${ms}ms${label ? `，${label}` : ""}）`),
          ),
        ms,
      )
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export function calSign(body: string, ts: string, randStr: string): string {
  const enc = encodeURIComponentCustom(body)
  const sorted = enc.split("").sort().join("")
  const words = CryptoJS.enc.Utf8.parse(sorted)
  const b64 = CryptoJS.enc.Base64.stringify(words)
  const res = md5(b64) + md5(`${ts}:${randStr}`)
  return md5(res).toUpperCase()
}

export function randomString(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let res = ""
  for (let i = 0; i < len; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return res
}

export function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export class Yun139ApiClient {
  private addition: Yun139Addition
  public personalHost = "https://yun.139.com"
  public familyHost = "https://yun.139.com"
  public groupHost = "https://yun.139.com"
  public account = ""

  /**
   * 当前生效的授权串（不含 `Basic ` 前缀）。
   *
   * token 刷新后会被就地更新 —— 这是让储存长期不掉线的关键：
   * 139 的 token 有过期时间，官方客户端会在过期前换取新的 token
   * 并写回配置，这里采取同样的策略。
   */
  private authValue = ""
  /** 是否已执行过初始化（路由策略只需查一次） */
  private inited = false

  /**
   * 当前存储的 ID 与运行时 env。
   *
   * 由驱动的 `setRuntimeContext` 注入，供直链/目录缓存做**存储隔离**
   * 以及访问 KV 用。取不到时缓存退化为纯内存（不影响正确性）。
   */
  public storageId: any
  public env: any

  constructor(addition: Yun139Addition) {
    this.addition = addition
    this.authValue = this.normalizeAuth(addition.authorization || "")
    this.extractAccount()
  }

  private normalizeAuth(auth: string): string {
    let a = (auth || "").trim()
    if (a.startsWith("Basic ")) a = a.slice(6).trim()
    return a
  }

  private extractAccount(): void {
    if (!this.authValue) return
    try {
      const decoded = CryptoJS.enc.Base64.parse(this.authValue).toString(
        CryptoJS.enc.Utf8,
      )
      const splits = decoded.split(":")
      if (splits.length >= 2) {
        this.account = splits[1]
      }
    } catch {
      // Ignored
    }
  }

  public getAuthString(): string {
    return this.authValue
  }

  /** 当前授权串（供驱动回写到储存配置，实现持久化续期） */
  public getAuthorization(): string {
    return this.authValue
  }

  isPersonalNew(): boolean {
    return !this.addition.type || this.addition.type === "personal_new"
  }

  isFamily(): boolean {
    return this.addition.type === "family"
  }

  isGroup(): boolean {
    return this.addition.type === "group"
  }

  getHost(): string {
    if (this.isFamily()) return this.familyHost
    if (this.isGroup()) return this.groupHost
    return this.personalHost
  }

  /**
   * 通用请求头（`user-njs` / 家庭云等公共域名使用）。
   */
  private buildCommonHeaders(bodyStr: string): Record<string, string> {
    const ts = formatTime(new Date())
    const randStr = randomString(16)
    const sign = calSign(bodyStr, ts, randStr)
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "CMS-DEVICE": "default",
      Authorization: `Basic ${this.authValue}`,
      "mcloud-channel": "1000101",
      "mcloud-client": "10701",
      "mcloud-sign": `${ts},${randStr},${sign}`,
      "mcloud-version": "7.14.0",
      Origin: "https://yun.139.com",
      Referer: "https://yun.139.com/w/",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": this.isFamily() ? "2" : "1",
      "Inner-Hcy-Router-Https": "1",
    }
  }

  /**
   * 个人盘新版专用请求头。
   *
   * 与公共头的差异（缺任一都会导致接口返回"资源不存在"）：
   *   - `Mcloud-Route: 001` 必带
   *   - 整套 `X-Yun-*` 头
   *   - `Caller: web`
   */
  private buildPersonalHeaders(bodyStr: string): Record<string, string> {
    const ts = formatTime(new Date())
    const randStr = randomString(16)
    const sign = calSign(bodyStr, ts, randStr)
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Authorization: `Basic ${this.authValue}`,
      Caller: "web",
      "Cms-Device": "default",
      "Mcloud-Channel": "1000101",
      "Mcloud-Client": "10701",
      "Mcloud-Route": "001",
      "Mcloud-Sign": `${ts},${randStr},${sign}`,
      "Mcloud-Version": "7.14.0",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": this.isFamily() ? "2" : "1",
      "X-Yun-Api-Version": "v1",
      "X-Yun-App-Channel": "10000034",
      "X-Yun-Channel-Source": "10000034",
      "X-Yun-Client-Info":
        "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||",
      "X-Yun-Module-Type": "100",
      "X-Yun-Svc-Type": "1",
    }
  }

  /**
   * 发起一次 139 请求。
   *
   * @param uriOrUrl 相对路径或完整 URL
   * @param body 请求体
   * @param usePersonalHeaders 是否使用个人盘专用请求头（个人盘相对路径建议开启）
   */
  async request<T = any>(
    uriOrUrl: string,
    body: any,
    usePersonalHeaders = false,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body || {})

    let url: string
    if (uriOrUrl.startsWith("http://") || uriOrUrl.startsWith("https://")) {
      url = uriOrUrl
    } else if (uriOrUrl.startsWith("/orchestration/")) {
      // Orchestration APIs are strictly hosted on yun.139.com
      url = `https://yun.139.com${uriOrUrl}`
    } else {
      url = `${this.getHost()}${uriOrUrl}`
    }

    const headers =
      usePersonalHeaders && !url.startsWith("https://user-njs")
        ? this.buildPersonalHeaders(bodyStr)
        : this.buildCommonHeaders(bodyStr)

    // ── 单次请求超时（关键：防止一次卡死拖满整个请求） ──────────────────
    //
    // 实测（2026-09-18 线上）：到 139 API 的单次往返本身就要 1~2 秒，
    // 且**偶发完全不响应** —— 客户端表现为 90~120 秒后超时（`http=000`）。
    // fs/get、PROPFIND 都因此出现「打十次卡两三次」的现象。
    //
    // 原来这里没有超时，一旦某个出站请求卡住，就只能等 CF 平台硬杀
    // （免费版 CPU 限制 / 子请求超时），期间该请求的所有并发工作全部白做，
    // 而且报错信息里看不出是哪一步卡住。
    //
    // 这里给每次往返设 8 秒上限：正常请求 1~2 秒必回，8 秒足够留出余量，
    // 而一旦超时能**尽快失败**，让上层（driver / op）按自己的语义降级或报错。
    //
    // ⚠️ 之后所有目录解析都走这里，所以超时值不能太小（否则网络抖动就误杀），
    //    也不能太大（否则单条卡死仍会耗尽整个请求预算）。
    const REQUEST_TIMEOUT_MS = 5000
    const res = await fetchWithTimeout(
      url,
      { method: "POST", headers, body: bodyStr },
      REQUEST_TIMEOUT_MS,
    )

    // body 读取同样要限时：139 存在「响应头快、body 半挂」的情况，
    // 裸 await res.json() 会一直等到 CF 平台 95 秒硬杀整个请求。
    if (!res.ok) {
      const text = await withTimeout(res.text(), REQUEST_TIMEOUT_MS, "读错误响应体")
      throw new Error(`139 Cloud API error (${res.status}): ${text.slice(0, 200)}`)
    }

    const json = (await withTimeout(
      res.json(),
      REQUEST_TIMEOUT_MS,
      "读响应体",
    )) as any
    if (json.success === false && json.message) {
      throw new Error(`139 Cloud API error: ${json.message} [${json.code || ""}]`)
    }
    return json as T
  }

  /**
   * 刷新 token。
   *
   * 139 的授权 token 有有效期；官方做法是在过期前用旧 token 换取新 token，
   * 服务端会返回有效期（秒）与新的 accessToken。这里只在剩余时间不足
   * 阈值时才刷新，避免频繁请求。
   *
   * @returns 是否成功刷新
   */
  async refreshToken(force = false): Promise<boolean> {
    if (!this.authValue) return false

    const inner = this.parseAuth()
    if (!inner) return false

    // 剩余时间充足则跳过（授权串第 4 段是签发时间戳，单位毫秒）
    if (!force && inner.issuedAt > 0) {
      const ageMs = Date.now() - inner.issuedAt
      const remainMs = 30 * 24 * 3600 * 1000 - ageMs
      if (remainMs > 15 * 24 * 3600 * 1000) return false
    }

    try {
      const res = await fetchWithTimeout(
        "https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do",
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: `<root><token>${inner.token}</token><account>${inner.account}</account><clienttype>656</clienttype></root>`,
        },
        8000,
      )
      const text = await res.text()
      const retCode = (text.match(/<return>([^<]*)<\/return>/) || [])[1]
      if (retCode !== "0") {
        return false
      }
      const newToken = (text.match(/<token>([^<]+)<\/token>/) || [])[1]
      if (!newToken) return false

      this.authValue = btoa(`pc:${inner.account}:${newToken}`)
      return true
    } catch {
      return false
    }
  }

  /** 解析授权串，取账号 / token / 签发时间 */
  private parseAuth(): {
    account: string
    token: string
    issuedAt: number
  } | null {
    try {
      const decoded = atob(this.authValue)
      const parts = decoded.split(":")
      if (parts.length < 3) return null
      const account = parts[1]
      const token = parts[2]
      const seg = token.split("|")
      const issuedAt = seg.length >= 4 ? Number(seg[3]) : 0
      return {
        account,
        token,
        issuedAt: Number.isFinite(issuedAt) ? issuedAt : 0,
      }
    } catch {
      return null
    }
  }

  async init(): Promise<void> {
    if (!this.authValue) {
      throw new Error("139 Cloud Authorization is required")
    }
    if (this.inited) return

    // 1) 先续期 token —— 过期前换取新的，避免中途掉线
    try {
      await this.refreshToken(false)
    } catch {
      // 续期失败不阻断，后续请求会用旧 token 碰运气
    }

    // 2) 查询路由策略，拿到真实的主机地址
    //
    //    注意：个人盘的接口主机**不能**硬编码为 yun.139.com，
    //    必须由本接口下发的 httpsUrl 决定（含 /hcy 之类的路由前缀）。
    try {
      const routeRes = await this.request<QueryRoutePolicyResp>(
        "https://user-njs.yun.139.com/user/route/qryRoutePolicy",
        {
          userInfo: {
            userType: 1,
            accountType: 1,
            accountName: this.account,
          },
          modAddrType: 1,
        },
      )

      if (routeRes.data?.routePolicyList) {
        for (const policy of routeRes.data.routePolicyList) {
          if (!policy.httpsUrl) continue
          if (policy.modName === "personal") {
            this.personalHost = policy.httpsUrl
          } else if (policy.modName === "group") {
            this.groupHost = policy.httpsUrl
          } else if (policy.modName === "family") {
            this.familyHost = policy.httpsUrl
          }
        }
      }
    } catch (e) {
      console.warn(
        "[139] queryRoutePolicy warning, fallback to default host:",
        e,
      )
    }

    this.inited = true
  }

  /**
   * 列目录。
   *
   * ## 缓存（性能关键）
   *
   * 线上实测：PROPFIND 连打十几次全部 200，但耗时在 1.0 ~ 7.5 秒之间跳动。
   * 浏览时「进子目录 → 返回上级 → 再进」的节奏会反复请求**同一批目录**，
   * 每次都做一次跨洲往返，既慢又浪费子请求配额（配额耗尽即 503）。
   *
   * 目录变化不频繁，60 秒 TTL 足以挡住这类重复请求，又不会让新增文件
   * 长时间不可见。命中时**零网络往返**。
   */
  async listFiles(folderId = ""): Promise<{
    files: Yun139FileItem[]
    folders: Array<{
      catalogID: string
      catalogName: string
      updateTime?: string
    }>
  }> {
    type ListResult = {
      files: Yun139FileItem[]
      folders: Array<{
        catalogID: string
        catalogName: string
        updateTime?: string
      }>
    }

    // ① 缓存命中：直接返回
    const cached = await getCachedList<ListResult>(
      this.addition,
      this.storageId,
      folderId,
    )
    if (cached) return cached

    // ② 回源
    const result = await this.fetchListFiles(folderId)
    if (result) {
      setCachedList(this.addition, this.storageId, folderId, result)
    }
    return result
  }

  /** 真正向 139 拉目录（不含缓存），由 `listFiles` 调用 */
  private async fetchListFiles(folderId = ""): Promise<{
    files: Yun139FileItem[]
    folders: Array<{
      catalogID: string
      catalogName: string
      updateTime?: string
    }>
  }> {
    if (this.isPersonalNew()) {
      let nextPageCursor = ""
      const allItems: PersonalFileItem[] = []
      const parentFileId = folderId || this.addition.root_folder_id || "/"

      /**
       * ⚠️ 分页循环**必须设上限并防御重复 cursor**，否则会无限打请求。
       *
       * ## 真实故障（2026-09-18 线上，最难定位的一个）
       *
       * 线上表现为：`fs/list` 打 15 次卡死 3 次，且耗时**精确整齐地停在
       * 95.000s**（CF 平台硬杀）。诡异之处在于：
       *
       *   - 给单次 fetch 加 5 秒超时**完全无效**；
       *   - 给 `res.json()` 加超时**也无效**；
       *   - 不访问 139 的公共接口 6/6 全部正常（0.7~3.8s）。
       *
       * 原因就在这里：单次请求都**正常且快速**（1~2 秒就返回），所以任何
       * "单次调用超时"都不会触发；但 `while (nextPageCursor)` 只要 139
       * 返回的 cursor **不再变化**（同一个值反复给），循环就会一直转下去，
       * 一次次累加到平台上限 —— 于是表现为"每个请求都很快，但整个请求卡死"。
       *
       * 双重保护：
       *   1. `pages` 计数上限，兜住纯粹的无限分页；
       *   2. `seenCursors` 去重，发现 cursor 原地打转立刻停止。
       *
       * 这两条都是**防御性**的：正常目录一两页就结束，不会触及阈值；
       * 一旦触发就说明上游行为异常，此时**宁可返回已拿到的部分数据**，
       * 也绝不能让整个请求被平台杀掉（那会让用户连目录都看不到）。
       */
      const MAX_PAGES = 30
      const seenCursors = new Set<string>()
      let pages = 0

      do {
        const res = await this.request<PersonalListResp>(
          "/file/list",
          {
            parentFileId,
            pageInfo: {
              pageCursor: nextPageCursor,
              pageSize: 200,
            },
            orderBy: "updated_at",
            orderDirection: "DESC",
            // ⚠️ 不请求缩略图。
            //
            // 原值 `["Small", "Large"]` 会让 139 为**每个条目**附带
            // 多档缩略图 URL（含签名串），响应体因此显著膨胀。而列表
            // （WebDAV PROPFIND / fs/list）只用得到名称、大小、时间，
            // 缩略图是前端详情页才需要的。
            //
            // 实测：去掉后单次 `listFiles` 的 2.7~3.4 秒进一步下降，
            // 跨洲回程传输是这一段耗时的主要构成。
            imageThumbnailStyleList: [],
          },
          true,
        )

        const items = res.data?.items || []
        allItems.push(...items)

        const cursor = res.data?.nextPageCursor || ""
        pages++

        // cursor 原地打转（重复值）或超过页数上限，立即停止，
        // 返回已拿到的部分数据 —— 绝不为了"完整"而把请求拖死。
        if (!cursor || seenCursors.has(cursor) || pages >= MAX_PAGES) {
          nextPageCursor = ""
          break
        }
        seenCursors.add(cursor)
        nextPageCursor = cursor
      } while (nextPageCursor)

      const folders = allItems
        .filter((i) => i.type === "folder")
        .map((i) => ({
          catalogID: i.fileId,
          catalogName: i.name,
          updateTime: i.updatedAt,
        }))

      const files: Yun139FileItem[] = allItems
        .filter((i) => i.type !== "folder")
        .map((i) => ({
          contentID: i.fileId,
          contentName: i.name,
          contentSize: i.size,
          updateTime: i.updatedAt,
          createTime: i.createdAt,
          thumbnailURL: i.thumbnailUrls?.[0]?.url,
        }))

      return { files, folders }
    }

    return this.getDisk(folderId)
  }

  async getDisk(catalogId = ""): Promise<{
    files: Yun139FileItem[]
    folders: Array<{
      catalogID: string
      catalogName: string
      updateTime?: string
    }>
  }> {
    const res = await this.request<Yun139DiskResp>(
      "/orchestration/personalCloud/catalog/v1.0/getDisk",
      {
        catalogID: catalogId || "",
        sortDirection: 1,
        filterType: 0,
        catalogSortType: 0,
        contentSortType: 0,
        startNumber: 1,
        endNumber: 5000,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )

    const diskResult = res.data?.getDiskResult
    return {
      files: diskResult?.fileList || [],
      folders: diskResult?.catalogList || [],
    }
  }

  /**
   * 取文件直链（播放地址）。
   *
   * ## 缓存（性能关键）
   *
   * 线上实测：同一 .strm 的播放地址连打 8 次，全部 302 成功，但耗时在
   * 2.0s / 6.4s / 7.2s / 9.5s / 13.8s / 13.9s 之间跳动 —— **波形 7 倍**。
   * `wrangler tail` 显示 CPU 仅 64~160ms、零异常，时间全花在等 139 往返
   * （Worker 出口在欧洲 AMS/LHR，139 机房在国内）。
   *
   * 客户端等不及就报「WebDAV 地址错误」，且**同一部片子时好时坏** ——
   * 快的那些次能播，慢的那些次超时。这就是用户看到的现象。
   *
   * 139 返回的是 EOS 预签名直链，查询串带 `X-Amz-Expires=900`（15 分钟），
   * 有效期内复用完全安全。故缓存 10 分钟，命中时**零网络往返**。
   *
   * ⚠️ 缓存键必须按存储隔离（`storageScope`），否则同一账号下多个存储
   * （不同 root_folder_id）会互相串用 fileId → 取到别人的直链。
   */
  async getDownloadUrl(contentIdOrFileId: string): Promise<string> {
    if (!contentIdOrFileId) {
      throw new Error("Empty file id passed to getDownloadUrl")
    }

    // ── ① 缓存命中：直接返回，不碰网络 ──────────────────────────────────
    const hit = await getCachedLink(
      this.addition,
      this.storageId,
      contentIdOrFileId,
    )
    if (hit) {
      return hit
    }

    // ── ② 未命中：回源 139 取直链，成功即写缓存 ─────────────────────────
    const url = await this.fetchDownloadUrl(contentIdOrFileId)
    if (url) {
      setCachedLink(this.addition, this.storageId, contentIdOrFileId, url)
    }
    return url
  }

  /** 真正向 139 请求直链（不含缓存），由 `getDownloadUrl` 调用 */
  private async fetchDownloadUrl(
    contentIdOrFileId: string,
  ): Promise<string> {
    if (this.isPersonalNew()) {
      const res = await this.request<PersonalDownloadResp>(
        "/file/getDownloadUrl",
        {
          fileId: contentIdOrFileId,
        },
        true,
      )
      // 直链优先级：cdnUrl（CDN 直链）> url（EOS 中转链）
      //
      // 为什么不能看 cdnSwitch：
      //   139 返回的 `url` 是 EOS 中转链，路径里带
      //   `response-content-disposition=attachment`，客户端（尤其网易爆米花
      //   这类播放器）会把它当成"下载文件"而不是"播放视频"，表现为
      //   "获取播放地址失败"。
      //   而 `cdnUrl` 是 yun.mcloud.139.com/cdnv1/... 的干净直链，无下载头。
      //
      // 官方 Go 版（drivers/139/util.go personalGetLink）同样是**无条件**
      // 优先 cdnUrl，只在 cdnUrl 为空时才回退 url —— 不看 cdnSwitch。
      // 此前 TS 版写成 `cdnSwitch ? cdnUrl : url`，只要 cdnSwitch 为 false
      // 就会去取带 attachment 的 EOS 链，这正是播放失败的直接原因。
      const url = res.data?.cdnUrl || res.data?.url
      if (!url) {
        throw new Error("Empty download URL received from 139 Cloud")
      }
      return url
    }

    const res = await this.request<Yun139DownloadResp>(
      "/orchestration/personalCloud/uploadAndDownload/v1.0/downloadRequest",
      {
        contentID: contentIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )

    const url = res.data?.downloadURL || res.data?.url
    if (!url) {
      throw new Error("Empty download URL received from 139 Cloud")
    }
    return url
  }

  async createCatalog(parentCatalogId: string, name: string): Promise<string> {
    if (this.isPersonalNew()) {
      const res = await this.request<any>(
        "/file/create",
        {
          parentFileId: parentCatalogId || this.addition.root_folder_id || "/",
          name,
          description: "",
          type: "folder",
          fileRenameMode: "force_rename",
        },
        true,
      )
      return res.data?.fileId || ""
    }

    const res = await this.request<any>(
      "/orchestration/personalCloud/catalog/v1.0/createCatalog",
      {
        parentCatalogID: parentCatalogId || "",
        catalogName: name,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
    return res.data?.catalogID || ""
  }

  /**
   * 删除文件。
   *
   * 注意：个人盘新版的删除接口是 `/recyclebin/batchTrash`（移入回收站），
   * **不是** `/file/delete`。用错路径会返回 404 + "认证失败"，
   * 极容易被误判成 token 失效。
   */
  async deleteFile(contentIdOrFileId: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/recyclebin/batchTrash",
        {
          fileIds: [contentIdOrFileId],
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/deleteContent",
      {
        contentID: contentIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async deleteCatalog(catalogIdOrFileId: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/recyclebin/batchTrash",
        {
          fileIds: [catalogIdOrFileId],
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/deleteCatalog",
      {
        catalogID: catalogIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async rename(id: string, newName: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/file/update",
        {
          fileId: id,
          name: newName,
          description: "",
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/updateCatalogInfo",
      {
        catalogID: id,
        catalogName: newName,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async getStorageDetails(): Promise<{ total?: number; used?: number }> {
    try {
      const res = await this.request<Yun139StorageDetailsResp>(
        "/orchestration/personalCloud/catalog/v1.0/getUserDomainInfo",
        {
          commonAccountInfo: {
            account: this.account,
            accountType: 1,
          },
        },
      )
      return {
        total: res.data?.totalSize,
        used: res.data?.usedSize,
      }
    } catch {
      return {}
    }
  }
}
