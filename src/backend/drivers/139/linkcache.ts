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

/** KV 键前缀（按存储隔离，避免多存储互相覆盖） */
const KV_PREFIX = "opencas_linkcache_v1_"

/** KV 读超时：纯优化手段，超时即降级为回源，不能拖慢主流程 */
const KV_TIMEOUT_MS = 800

/** KV 回写防抖：避免热路径频繁写 */
const FLUSH_DEBOUNCE_MS = 2000

interface Entry<T> {
  /** 过期时间戳（ms） */
  exp: number
  /** 缓存值 */
  v: T
}

/* ── 进程内缓存 ─────────────────────────────────────────────────────────── */

const memLink = new Map<string, Entry<string>>()
const memList = new Map<string, Entry<unknown>>()

/* ── 待回写的 KV 键（防抖） ─────────────────────────────────────────────── */

const dirty = new Map<string, Entry<unknown>>()
let flushTimer: any

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
 * 用 authorization 的哈希前 8 位 + storageId 组合，避免把 token 明文写进键名。
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

function linkKey(scope: string, fileId: string): string {
  return `${KV_PREFIX}lnk_${scope}_${fileId}`
}

function listKey(scope: string, folderId: string): string {
  return `${KV_PREFIX}lst_${scope}_${folderId || "root"}`
}

/* ── KV 绑定 ────────────────────────────────────────────────────────────── */

let cachedBinding: { value: any; at: number } | undefined

/** KV binding 缓存 TTL —— 探测一次即可，不必每层都翻 env */
const KV_BINDING_TTL_MS = 60 * 1000

/**
 * 取 KV 绑定（带 TTL 缓存）。
 *
 * 与 `pathindex.ts` 保持一致：存储后端由 store 子系统按部署环境决定
 * （KV / Blob / D1 / Durable Object…），统一通过 `getKvBinding` 探测。
 * 探测失败返回 null，缓存退化为纯内存 —— 不影响正确性，只是少了跨
 * isolate 复用。
 */
async function getBinding(env?: any): Promise<any> {
  if (cachedBinding && now() - cachedBinding.at < KV_BINDING_TTL_MS) {
    return cachedBinding.value
  }
  try {
    const mod: any = await import("../../internal/model/store/json")
    const { binding, mode } = await mod.getKvBinding(env)
    if (!binding || mode === "none") return null
    cachedBinding = { value: binding, at: now() }
    return binding
  } catch {
    return null
  }
}

async function kvGet<T>(key: string, env?: any): Promise<Entry<T> | undefined> {
  const kv = await getBinding(env)
  if (!kv?.get) return undefined
  try {
    const raw = await withTimeout(kv.get(key, "json"), KV_TIMEOUT_MS)
    if (!raw || typeof raw !== "object") return undefined
    const e = raw as Entry<T>
    if (typeof e.exp !== "number" || e.exp < now()) return undefined
    return e
  } catch {
    return undefined
  }
}

function scheduleFlush(env?: any): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flushCache()
  }, FLUSH_DEBOUNCE_MS)
  // Node/测试环境下 unref，避免拖住进程退出
  try {
    flushTimer?.unref?.()
  } catch {
    /* ignore */
  }
}

/** 把所有待回写的键批量写入 KV（由防抖触发） */
export async function flushCache(env?: any): Promise<void> {
  if (dirty.size === 0) return
  const kv = await getBinding(env)
  if (!kv?.put) {
    dirty.clear()
    return
  }
  const batch = Array.from(dirty.entries())
  dirty.clear()
  await Promise.all(
    batch.map(async ([key, entry]) => {
      try {
        // 回写必须限时：KV put 一旦挂起会把整个请求拖到平台硬杀
        await withTimeout(kv.put(key, JSON.stringify(entry)), KV_TIMEOUT_MS)
      } catch {
        /* 缓存写失败不影响主流程 */
      }
    }),
  )
}

/* ── 直链缓存 ───────────────────────────────────────────────────────────── */

/**
 * 读缓存的直链。命中返回字符串，未命中返回 undefined。
 *
 * 两层顺序：进程内 Map → KV → 未命中。
 */
export async function getCachedLink(
  addition: any,
  storageId: any,
  fileId: string,
  env?: any,
): Promise<string | undefined> {
  if (!fileId) return undefined
  const scope = storageScope(addition, storageId)

  // ① 进程内
  const mk = `${scope}_${fileId}`
  const m = memLink.get(mk)
  if (m && m.exp > now()) return m.v
  if (m) memLink.delete(mk)

  // ② KV
  const e = await kvGet<string>(linkKey(scope, fileId), env)
  if (e) {
    memLink.set(mk, e)
    return e.v
  }
  return undefined
}

/** 写入直链缓存（内存立即生效 + KV 防抖回写） */
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
  const k = linkKey(scope, fileId)
  dirty.set(k, entry)
  scheduleFlush()
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
  env?: any,
): Promise<T | undefined> {
  const scope = storageScope(addition, storageId)
  const mk = `${scope}_${folderId || "root"}`

  const m = memList.get(mk) as Entry<T> | undefined
  if (m && m.exp > now()) return m.v
  if (m) memList.delete(mk)

  const e = await kvGet<T>(listKey(scope, folderId), env)
  if (e) {
    memList.set(mk, e as Entry<unknown>)
    return e.v
  }
  return undefined
}

/** 写入目录列表缓存 */
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
  dirty.set(listKey(scope, folderId), entry)
  scheduleFlush()
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
