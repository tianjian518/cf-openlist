/**
 * 139 / 189 驱动的「直链 + 目录列表」缓存
 *
 * ## 为什么需要（线上真实症状）
 *
 * 网易爆米花经 WebDAV 播放时报「WebDAV 地址错误」，且**同一部电影时好时坏**：
 *
 *   - 实测同一 .strm 连打 10 次：全部 HTTP 200，耗时却在 1.1 ~ 8.3 秒之间跳动；
 *   - 再请求 .strm 里的播放地址（302 到 139 直链）8 次：全部 302，
 *     耗时 2.0s / 6.4s / 7.2s / 9.5s / 13.8s / 13.9s —— **波动 7 倍**；
 *   - `wrangler tail` 显示 CPU 仅 64~160ms、零异常 ⇒ 时间**全花在等 139 往返**。
 *
 * 结论：不是地址错，是**慢**。快的时候客户端能播，慢的时候客户端等不及，
 * 报出的文案恰好是「地址错误」，极具误导性。而取不到 .strm 内容时代码
 * 主动返回 503（`raw.ts`），这就是「重试又能进」的来源。
 *
 * ## 为什么能缓存
 *
 * 139 返回的直链是 EOS 预签名 URL，查询串里带 `X-Amz-Expires=900`（15 分钟）。
 * 在有效期内复用完全安全，因此把直链缓存 10 分钟即可让播放请求
 * **零网络往返**、毫秒级返回。
 *
 * ## 两层缓存
 *
 * - **进程内 Map**：同一 isolate 内命中即返回（最快的路径）；
 * - **KV**：CF Workers 的 isolate 会在 AMS/LHR 等机房之间漂移
 *   （实测同客户端连续请求会落到不同机房），进程内缓存命中率极低，
 *   因此必须持久化到 KV 才能真正跨请求复用。
 *
 * 写入 KV 走防抖，避免浏览热路径上每列一次目录就写一次。
 */

/** 直链缓存时长：139 直链本身有效期 900s，留足余量取 600s（10 分钟） */
export const LINK_TTL_MS = 10 * 60 * 1000

/** 目录列表缓存时长：目录变化不频繁，60 秒足够挡住「返回上级」的重复请求 */
export const LIST_TTL_MS = 60 * 1000

/**
 * 缓存键前缀（按存储隔离，避免多存储互相覆盖）。
 *
 * ## ⚠️ 为什么不用 KV 存（血泪教训）
 *
 * 最初把直链/目录缓存写进主 KV（`openlist-tsworkers-kv`），线上实测直接撞墙：
 *
 *     KV put() limit exceeded for the day
 *
 * CF 免费版 KV **每天仅 1000 次写入**。而一次 `.strm` 请求要解析 3 层目录，
 * 每层写一个 key —— 也就是说**三百多次请求就把当日配额打爆**。
 *
 * 症状极具迷惑性：配额没满时缓存能写入（偶尔命中、偶尔 1 秒返回），
 * 写满后**所有缓存静默失效**，耗时重新变回 5~8 秒 ——
 * 表现为「同一部电影时好时坏」的加强版，让人误以为是网盘限流。
 *
 * 正解：改用 **Cache API**（`caches.default`）。它走 CDN 边缘缓存，
 * **不消耗 KV 写入配额**，且天然按 PoP 分布，正适合这种「读多写少、
 * 允许轻微陈旧」的加速场景。
 */
const CACHE_ORIGIN = "https://linkcache.internal"

/** Cache API 读写超时：纯优化手段，超时即降级为回源，不能拖慢主流程 */
const CACHE_TIMEOUT_MS = 800

interface Entry<T> {
  /** 过期时间戳（ms） */
  exp: number
  /** 缓存值 */
  v: T
}

/* ── 进程内缓存 ─────────────────────────────────────────────────────────── */

const memLink = new Map<string, Entry<string>>()
const memList = new Map<string, Entry<unknown>>()

/* ── 工具 ───────────────────────────────────────────────────────────────── */

function now(): number {
  return Date.now()
}

/** 给 Promise 套超时，超时抛错（调用方 catch 后降级） */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: any
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 存储隔离键。
 *
 * 同一账号可能有多个存储（不同 root_folder_id），直链与目录 ID 都不能跨存储复用，
 * 否则会把 A 存储的目录 ID 当成 B 存储的去查，返回错误内容。
 * 用 authorization 的哈希 + root + storageId 组合，避免把 token 明文写进键名。
 */
function storageScope(addition: any, storageId?: any): string {
  const auth = String(addition?.authorization || "")
  let h = 0
  for (let i = 0; i < auth.length; i++) {
    h = (h * 31 + auth.charCodeAt(i)) | 0
  }
  const root = String(
    addition?.root_folder_id || addition?.rootFolderId || "",
  ).slice(0, 24)
  return `${(h >>> 0).toString(36)}_${root}_${String(storageId ?? "")}`
}

/**
 * 生成 Cache API 的 key URL。
 *
 * ⚠️ 必须把 `scope`、`kind`、`id` 全部编码进**路径**（而非查询串）。
 * Cache API 的 key 就是 URL 本身，路径分段可读性更好，也便于排查。
 * `encodeURIComponent` 保证目录 ID / fileId 里的特殊字符（`-`、`_` 虽安全，
 * 但 139 的 ID 可能含 `+`、`/`）不会破坏分段结构。
 */
function cacheKeyUrl(
  scope: string,
  kind: "lnk" | "lst",
  id: string,
): string {
  return `${CACHE_ORIGIN}/${kind}/${encodeURIComponent(scope)}/${encodeURIComponent(id || "root")}`
}

/**
 * 取 Cache API 实例。
 *
 * `caches.default` 在 CF Workers 上始终可用；本地 Node / 测试环境没有，
 * 返回 undefined 于是缓存退化为纯进程内（不影响正确性）。
 */
function getCache(): any {
  try {
    return (globalThis as any).caches?.default
  } catch {
    return undefined
  }
}

/** 从 Cache API 读一个键，未命中或过期返回 undefined */
async function cacheGet<T>(url: string): Promise<Entry<T> | undefined> {
  const c = getCache()
  if (!c?.match) return undefined
  try {
    const res = await withTimeout<Response>(c.match(url), CACHE_TIMEOUT_MS)
    if (!res) return undefined
    const e = (await withTimeout<Entry<T>>(res.json(), CACHE_TIMEOUT_MS)) as Entry<T>
    if (!e || typeof e.exp !== "number" || e.exp < now()) return undefined
    return e
  } catch {
    return undefined
  }
}

/**
 * 写一个键到 Cache API。
 *
 * TTL 由响应的 `Cache-Control: max-age` 承担，不再依赖 `dirty` 队列 ——
 * 这正是选 Cache API 的原因：**写操作不需要等待、不需要配额、不会失败**。
 */
async function cacheSet<T>(url: string, entry: Entry<T>, ttlMs: number): Promise<void> {
  const c = getCache()
  if (!c?.put) return
  try {
    const body = JSON.stringify(entry)
    const ttl = Math.max(1, Math.floor(ttlMs / 1000))
    const res = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        // Cache API 依据响应头决定 TTL；过期后自动不可命中
        "Cache-Control": `public, max-age=${ttl}`,
      },
    })
    await withTimeout(c.put(url, res), CACHE_TIMEOUT_MS)
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/* ── 直链缓存 ───────────────────────────────────────────────────────────── */

/**
 * 读缓存的直链。命中返回字符串，未命中返回 undefined。
 *
 * 两层顺序：进程内 Map → Cache API → 未命中。
 */
export async function getCachedLink(
  addition: any,
  storageId: any,
  fileId: string,
): Promise<string | undefined> {
  if (!fileId) return undefined
  const scope = storageScope(addition, storageId)

  // ① 进程内（最快路径）
  const mk = `${scope}_${fileId}`
  const m = memLink.get(mk)
  if (m && m.exp > now()) return m.v
  if (m) memLink.delete(mk)

  // ② Cache API（跨 isolate / 跨机房复用）
  const e = await cacheGet<string>(cacheKeyUrl(scope, "lnk", fileId))
  if (e) {
    memLink.set(mk, e)
    return e.v
  }
  return undefined
}

/** 写入直链缓存（内存立即生效 + Cache API 落盘） */
export function setCachedLink(
  addition: any,
  storageId: any,
  fileId: string,
  url: string,
): void {
  if (!fileId || !url) return
  const scope = storageScope(addition, storageId)
  const entry: Entry<string> = { exp: now() + LINK_TTL_MS, v: url }
  memLink.set(`${scope}_${fileId}`, entry)
  // Cache API 的写操作不需要配额、不会因 isolate 回收而丢失，
  // 因此无需 waitUntil / 防抖，直接发起即可（失败也只是下次回源）。
  void cacheSet(cacheKeyUrl(scope, "lnk", fileId), entry, LINK_TTL_MS)
}

/* ── 目录列表缓存 ───────────────────────────────────────────────────────── */

/**
 * 读缓存的目录列表。
 *
 * 目录列表用于两处：
 *   1. WebDAV PROPFIND（浏览）—— 直接决定「进子目录 / 返回上级」快不快；
 *   2. strm 驱动生成 .strm 内容时定位文件 ID。
 *
 * 60 秒 TTL 足以挡住用户来回翻目录造成的重复请求，又不会让新增文件
 * 长时间不可见。
 */
export async function getCachedList<T>(
  addition: any,
  storageId: any,
  folderId: string,
): Promise<T | undefined> {
  const scope = storageScope(addition, storageId)
  const mk = `${scope}_${folderId || "root"}`

  const m = memList.get(mk) as Entry<T> | undefined
  if (m && m.exp > now()) return m.v
  if (m) memList.delete(mk)

  const e = await cacheGet<T>(cacheKeyUrl(scope, "lst", folderId))
  if (e) {
    memList.set(mk, e as Entry<unknown>)
    return e.v
  }
  return undefined
}

/** 写入目录列表缓存（内存立即生效 + Cache API 落盘） */
export function setCachedList<T>(
  addition: any,
  storageId: any,
  folderId: string,
  value: T,
): void {
  if (!value) return
  const scope = storageScope(addition, storageId)
  const entry: Entry<T> = { exp: now() + LIST_TTL_MS, v: value }
  memList.set(`${scope}_${folderId || "root"}`, entry as Entry<unknown>)
  void cacheSet(cacheKeyUrl(scope, "lst", folderId), entry, LIST_TTL_MS)
}

/**
 * 清空某存储的全部缓存。
 *
 * 用于「用户刚上传/删除了文件」这类需要立刻看到变化的场景。
 * 缓存本身有 TTL 兜底，这里只提供主动失效能力。
 */
export function invalidateStorage(addition: any, storageId?: any): void {
  const scope = storageScope(addition, storageId)
  for (const k of Array.from(memLink.keys())) {
    if (k.startsWith(`${scope}_`)) memLink.delete(k)
  }
  for (const k of Array.from(memList.keys())) {
    if (k.startsWith(`${scope}_`)) memList.delete(k)
  }
}
