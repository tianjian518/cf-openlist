/**
 * 139 云盘 CAS 播放
 *
 * 原始实现。负责把「CAS 占位文件」变成「可播放的直链」。
 *
 * 完整链路：
 *   ① 读取 .cas 文件内容 → base64 解码 → 得到 CasMeta
 *   ② 在临时目录用 SHA256 秒传恢复真实文件（零字节传输）
 *   ③ 取该文件的下载直链
 *   ④ 返回直链给播放器
 *   ⑤ 延时清理临时副本（配合惰性清扫与定时清扫兜底）
 */

import { CasMeta, decodeCas, deriveRealName, extAllowed } from "./format"
import {
  ensureTempDir,
  makeTempPrefix,
  restoreFromCas,
  safeDelete,
  sweepTempFiles,
} from "./restore"
import { Yun139ApiClient, fetchWithTimeout, withTimeout } from "../util"

/** 播放直链结果 */
export interface CasPlayLink {
  /** 可播放的直链 */
  url: string
  /** 真实文件字节数，供播放器显示进度 */
  size: number
  /** 真实文件名 */
  name: string
  /** 请求直链时需要携带的头 */
  headers?: Record<string, string>
  /** 本次使用的临时目录 ID（供驱动缓存复用，省一次列目录往返） */
  tempDirId?: string
}

/** 播放失败的错误（带用户可读信息） */
export class CasPlayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CasPlayError"
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * CAS 直链缓存（专治播放路径慢 → 503）
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 播放直链缓存。
 *
 * ## 为什么必须有
 *
 * `resolveCasPlayLink` 每次都要**串行**走完整条链路（实测 3~13 秒）：
 *
 *   ① `getDownloadUrl(casFileId)` + fetch 读 `.cas` 内容   ~1.5s
 *   ② `ensureTempDir` 列根目录找 TEMP                       ~1.0s
 *   ③ `restoreFromCas` 秒传 create                          ~2.0s
 *   ④ `getDownloadUrl(restoredFileId)` 取直链               ~1.5s
 *
 * 而播放器拿到 `.strm`/`.cas` 后**会反复请求**（起播探测、拖动进度、
 * 多段 Range、重试），每一次都重跑整条链路。CF Workers 的子请求数与
 * CPU 时间都有硬上限，几条并发请求叠起来就被边缘节点直接拒绝 ——
 * 这正是线上**偶发 503** 的主因。而 139 的下载直链本身有效期约 15 分钟，
 * 同一条 URL 完全可以复用。
 *
 * ## ⚠️ 为什么必须用 KV/Cache 而不是模块级 Map
 *
 * 最初这里用模块级 `Map` 实现，**实测完全无效**（302 生成仍要 3~13 秒）。
 * 原因是 CF Workers 的调度模型：**同一份模块状态只在同一个 isolate 内共享**，
 * 而边缘节点会按负载把请求分散到多个 isolate，甚至为并发请求各起一个。
 * 于是「刚写进 Map 的直链」在下一次请求时根本读不到。
 *
 * 实测证据：同一 URL 连打 10 次 `HEAD`，耗时 3.3 / 4.2 / 5.0 / 8.3 /
 * 9.0 / 10.0 / 11.6 / 12.8 / 13.2 秒 —— 毫无收敛趋势，说明每次都重跑链路。
 *
 * ## ⚠️⚠️ 曾经的严重误判：KV 会撞「每日 1000 次写」配额（血泪）
 *
 * 后来改用 **KV** 作共享缓存层（KV 跨 isolate / 跨节点一致），**线上依然不命中**。
 *
 * 线上实测证据（决定性的）：
 *
 *     GET /storage/kv/namespaces/<主KV>/keys?prefix=caslink:  →  0 条
 *
 * 代码明明 `await kv.put("caslink:" + id, ...)`，线上**一个键都没有**。
 * 原因：CF 免费版 KV **每天仅 1000 次写入**，而 `openlist_config`、
 * `opencas_139_idx_*` 等主配置也共用同一个 KV，几百次播放就把当日写配额打满，
 * `put` 全部失败 —— 且被 `catch {}` 静默吞掉，**不留任何日志**。
 * 写不进去 ⇒ 缓存永远为空 ⇒ 每次播放仍重跑整条链路 ⇒ 稳定 8~13 秒。
 *
 * 正解：改用 **Cache API**（`caches.default`）。它走 CDN 边缘缓存，
 * **不消耗 KV 写配额、写入不需等待、不会失败**，天然按 PoP 分布，
 * 正适合「读多写少、允许轻微陈旧」的直链加速场景。
 *
 * ⚠️ 注意：Cache API 的缓存是**按机房（PoP）隔离**的，跨洲不共享。
 * 但只要出口机房稳定，同机房内的重复播放即可零网络往返命中。
 *
 * ## 缓存键为什么是 `casFileId`
 *
 * CAS 文件的 `contentID` 在云端稳定且与虚拟路径无关，用 fileId 作键天然
 * 避免「同一文件经不同挂载点/别名访问」时的重复落空。
 */
interface CasLinkCacheEntry {
  url: string
  size: number
  name: string
  headers?: Record<string, string>
  tempDirId?: string
  /** 写入时刻（毫秒） */
  at: number
}

/**
 * 直链缓存 TTL。
 *
 * 139 的下载直链 `X-Amz-Expires=900`（15 分钟，见 302 的 location 参数），
 * 这里取 10 分钟留足安全余量 —— 宁可偶尔多跑一次链路，也不要让播放器
 * 拿到一条即将失效的 URL（那会表现为「能起播但拖动就断」）。
 */
const CAS_LINK_TTL_MS = 10 * 60 * 1000

/** 一级缓存容量上限（per-isolate），防止长时间存活的 isolate 无限增长 */
const CAS_LINK_CACHE_MAX = 200

/** 直链缓存的键前缀（Cache API 的 URL 路径里复用同一前缀，便于排查） */
const CAS_LINK_KV_PREFIX = "caslink:"

/** Cache API 的 key 必须是一个 URL，这里用内部域名占位（不会真正请求） */
const CAS_CACHE_ORIGIN = "https://caslink.internal"

/** 一级缓存：模块级 Map，仅在同一 isolate 内有效（快，但覆盖不全） */
const casLinkCache = new Map<string, CasLinkCacheEntry>()

/** 读取一级缓存（含 TTL 校验与 LRU 位置更新） */
function getLocalCasLink(casFileId: string): CasLinkCacheEntry | null {
  const hit = casLinkCache.get(casFileId)
  if (!hit) return null
  if (Date.now() - hit.at > CAS_LINK_TTL_MS) {
    casLinkCache.delete(casFileId)
    return null
  }
  // Map 保持插入序，删后重插 = 移到队尾，实现简易 LRU
  casLinkCache.delete(casFileId)
  casLinkCache.set(casFileId, hit)
  return hit
}

/** 写入一级缓存（超容量时淘汰最旧的一条） */
function setLocalCasLink(casFileId: string, entry: CasLinkCacheEntry): void {
  casLinkCache.delete(casFileId)
  casLinkCache.set(casFileId, entry)
  while (casLinkCache.size > CAS_LINK_CACHE_MAX) {
    const oldest = casLinkCache.keys().next().value
    if (oldest === undefined) break
    casLinkCache.delete(oldest)
  }
}

/**
 * Cache API 读写超时：纯优化手段，超时即降级为回源，不能拖慢主流程。
 * 与 `../linkcache.ts` 保持同一取值。
 */
const CAS_CACHE_TIMEOUT_MS = 800

/** Cache API 的 key 用一个内部域名，路径里带前缀与 fileId */
function casCacheKeyUrl(casFileId: string): string {
  return `${CAS_CACHE_ORIGIN}/${CAS_LINK_KV_PREFIX}${encodeURIComponent(casFileId)}`
}

/**
 * 取 Cache API 实例。
 *
 * `caches.default` 在 CF Workers 上始终可用；本地 Node / 测试环境没有，
 * 返回 undefined 于是缓存退化为纯进程内（不影响正确性）。
 */
function getCacheApi(): any {
  try {
    return (globalThis as any).caches?.default
  } catch {
    return undefined
  }
}

/**
 * 读取直链缓存：先查一级（内存），再查 Cache API。
 *
 * 读失败（未命中、超时、环境不支持）一律静默降级为「未命中」——
 * 缓存只是优化手段，绝不能因为它出错而让播放失败。
 */
async function getCachedCasLink(
  casFileId: string,
): Promise<CasLinkCacheEntry | null> {
  const local = getLocalCasLink(casFileId)
  if (local) return local

  const c = getCacheApi()
  if (!c?.match) return null

  try {
    const res = await withTimeout<Response>(
      c.match(casCacheKeyUrl(casFileId)),
      CAS_CACHE_TIMEOUT_MS,
      "读 CAS 直链缓存",
    )
    if (!res) return null
    const entry = (await withTimeout(
      res.json(),
      CAS_CACHE_TIMEOUT_MS,
      "解析 CAS 直链缓存",
    )) as CasLinkCacheEntry
    if (!entry || typeof entry.url !== "string") return null
    if (Date.now() - (entry.at || 0) > CAS_LINK_TTL_MS) return null
    // 回填一级缓存，后续同 isolate 请求可零网络命中
    setLocalCasLink(casFileId, entry)
    return entry
  } catch {
    return null
  }
}

/**
 * 写入直链缓存：同时写一级与 Cache API。
 *
 * ⚠️ 与旧的 KV 实现的关键差别：
 *   - **不消耗任何写配额**，不会因每日 1000 次写上限而静默全失败；
 *   - 写入**不需要 await 到落盘**（Cache API 是即发即忘的边缘缓存）。
 *
 * TTL 由响应的 `Cache-Control: max-age` 承担，过期自动不可命中。
 * 写失败静默忽略（同样地，不能因缓存而影响播放）。
 */
async function setCachedCasLink(
  casFileId: string,
  entry: CasLinkCacheEntry,
  ttlSec: number,
): Promise<void> {
  setLocalCasLink(casFileId, entry)

  const c = getCacheApi()
  if (!c?.put) return

  try {
    const res = new Response(JSON.stringify(entry), {
      headers: {
        "Content-Type": "application/json",
        // Cache API 依据响应头决定 TTL；过期后自动不可命中
        "Cache-Control": `public, max-age=${ttlSec}`,
      },
    })
    await withTimeout(
      c.put(casCacheKeyUrl(casFileId), res),
      CAS_CACHE_TIMEOUT_MS,
      "写 CAS 直链缓存",
    )
  } catch {
    // 忽略：一级缓存仍然可用
  }
}

/**
 * 清空一级直链缓存（供测试使用）。
 *
 * ⚠️ 仅清内存，不动 KV —— 测试用真实 KV 会污染线上数据。
 * 正常播放不需要调用它，TTL 会自然淘汰。
 */
export function clearCasLinkCache(): void {
  casLinkCache.clear()
}

/** 默认允许播放的扩展名 */
const DEFAULT_VIDEO_EXT =
  "mp4,mkv,ts,m2ts,avi,mov,wmv,flv,webm,rmvb,rm,m4v,mpg,mpeg,3gp"

/**
 * 判断给定文件是否应按 CAS 播放流程处理。
 *
 * @param name 文件名
 * @param allowExt 白名单；空表示用默认视频扩展名
 */
export function shouldHandleCas(name: string, allowExt?: string): boolean {
  if (!/\.cas$/i.test(name)) return false
  const list = allowExt && allowExt.trim() ? allowExt : DEFAULT_VIDEO_EXT
  // CAS 文件名形如 movie.mp4.cas，去掉 .cas 再判断
  const inner = name.replace(/\.cas$/i, "")
  return extAllowed(inner, list)
}

/**
 * 读取 139 上的文件内容为文本。
 * CAS 文件只有几 KB，直接全量读取。
 */
export async function readCasContent(
  client: Yun139ApiClient,
  fileId: string,
): Promise<string> {
  const url = await client.getDownloadUrl(fileId)
  // 加超时：CDN 偶发不响应，原生 fetch 会一直挂着，
  // 最终把整个请求耗到 CF 平台强杀（客户端 90~120 秒超时）。
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Referer: "https://yun.139.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    },
    10000,
  )
  if (!res.ok) {
    throw new CasPlayError(`读取 CAS 文件失败（HTTP ${res.status}）`)
  }
  // body 读取也要限时：CDN 可能"响应头到达但 body 半挂"，
  // 裸 await res.text() 会拖到 CF 平台 95 秒硬杀整个请求。
  const text = await withTimeout(res.text(), 10000, "读 CAS 内容")
  if (text.length > 64 * 1024) {
    throw new CasPlayError("CAS 文件体积异常，疑似不是有效的占位文件")
  }
  return text
}

/** 解析 CAS 文本为元数据 */
export function parseCasMeta(content: string): CasMeta {
  const meta = decodeCas(content)
  if (!meta.sha256) {
    throw new CasPlayError(
      "该 CAS 文件未记录 SHA256，无法秒传恢复（可能是旧版工具生成）",
    )
  }
  return meta
}

export interface ResolveOpts {
  /** 139 客户端 */
  client: Yun139ApiClient
  /** 根目录 ID（个人新版为 "/"，家庭/群组为 catalogID） */
  rootId: string
  /** CAS 文件的 139 fileId */
  casFileId: string
  /** CAS 文件名（如 movie.mp4.cas） */
  casName: string
  /** 是否播放后自动清理临时副本，默认 true */
  autoCleanup?: boolean
  /** 延时清理的等待毫秒数，默认 120 秒 */
  cleanupDelayMs?: number
  /**
   * 已知的临时目录 ID（由驱动缓存注入）。
   *
   * 播放是延迟敏感路径，Workers 的子请求/CPU 均有硬限制；
   * 传入后可省掉一次"列根目录找 TEMP"的往返，降低超限（503）风险。
   */
  tempDirId?: string
  /**
   * 是否在播放前顺带做一次惰性清扫，默认 false。
   *
   * ⚠️ 默认**关闭**：清扫需要"列 TEMP 目录 + 逐个删除"，在播放热路径上
   * 会显著增加子请求数与耗时，正是 503 超限的主要来源之一。
   * 兜底清理请交给 worker 的 `scheduled` 定时任务（见 worker.ts）。
   */
  sweepOnPlay?: boolean
}

/**
 * 核心方法：由 CAS 文件换取播放直链。
 *
 * 流程：读 CAS 内容 → 解析元数据 → 秒传恢复 → 取直链 → 安排清理
 *
 * 出错时抛出带 `[step=...]` 前缀的 `CasPlayError`，便于在日志中快速
 * 定位失败环节（read / tempdir / restore / link）。
 */
export async function resolveCasPlayLink(
  opts: ResolveOpts,
): Promise<CasPlayLink> {
  const { client, casFileId, casName, rootId } = opts
  const autoCleanup = opts.autoCleanup !== false

  // ⓪ 直链缓存命中则直接返回（一级内存 / KV 共享层）。
  //
  // 这是播放路径快慢的关键：未命中时要串行走 4 次网络请求（实测 3~13s），
  // 而播放器会为起播探测 / 拖动 / 分段 Range 反复请求同一文件，
  // 每次重跑都白白消耗 Workers 的子请求与 CPU 配额，最终表现为 503。
  // 直链本身有效期约 15 分钟，10 分钟内复用完全安全。
  const cached = await getCachedCasLink(casFileId)
  if (cached) {
    return {
      url: cached.url,
      size: cached.size,
      name: cached.name,
      tempDirId: cached.tempDirId,
      headers: cached.headers,
    }
  }

  // ① 惰性清理（仅当显式开启；默认关闭以免拖慢播放）
  if (opts.sweepOnPlay === true) {
    await sweepTempFiles(client, rootId)
  }

  // ② 读取并解析 CAS
  let step = "read"
  let content = ""
  try {
    content = await readCasContent(client, casFileId)
  } catch (e) {
    throw new CasPlayError(
      `[step=${step}] ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const meta = parseCasMeta(content)
  const realName = deriveRealName(casName, meta.name)

  // ③ 秒传恢复到临时目录（带时间戳前缀，供后续清理识别）
  step = "tempdir"
  let tempDirId = ""
  try {
    tempDirId = await ensureTempDir(client, rootId, opts.tempDirId)
  } catch (e) {
    throw new CasPlayError(
      `[step=${step}] ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  const tempPrefix = makeTempPrefix()

  let restored: { fileId: string; fileName: string }
  try {
    restored = await restoreFromCas(client, tempDirId, casName, meta, tempPrefix)
  } catch (e) {
    throw new CasPlayError(
      `[step=restore] ${
        e instanceof Error ? e.message : "秒传恢复失败，无法播放该 CAS 文件"
      }`,
    )
  }

  // ④ 取直链
  let url: string
  try {
    url = await client.getDownloadUrl(restored.fileId)
  } catch (e) {
    // 取直链失败说明这个副本没用了，立即清掉避免堆积
    await safeDelete(client, restored.fileId)
    throw new CasPlayError(
      `[step=link fileId=${restored.fileId.slice(0, 12)}] 未能取得播放直链：${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  // ⑤ 安排清理
  if (autoCleanup) {
    scheduleCleanup(client, restored.fileId, opts.cleanupDelayMs ?? 120_000)
  }

  const headers = {
    Referer: "https://yun.139.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  }

  // ⑥ 写入直链缓存，供后续请求（拖动、分段、重试）零成本复用。
  //
  //    ⚠️ 仅缓存**成功**取得的直链 —— 上面若抛错则不会走到这里，
  //    故缓存里绝不会出现「空 URL」或失败结果。
  //
  //    KV 的 expirationTtl 留 60 秒余量（比内存 TTL 早一点过期），
  //    避免出现「KV 里的条目刚过期、却仍被当有效读回」的临界情况。
  await setCachedCasLink(
    casFileId,
    {
      url,
      size: meta.size,
      name: realName,
      tempDirId,
      headers,
      at: Date.now(),
    },
    Math.floor(CAS_LINK_TTL_MS / 1000),
  )

  return {
    url,
    size: meta.size,
    name: realName,
    tempDirId,
    headers,
  }
}

/**
 * 安排临时副本清理。
 *
 * ## ⚠️⚠️ 绝不能挂到 `ctx.waitUntil`（线上播放卡 30 秒的元凶，2026-09-20 定位）
 *
 * 本函数曾经把「延时 120 秒后删除副本」的任务交给 `ctx.waitUntil(task)`。
 * 这在 Cloudflare Workers 上是**灾难性**的，因为 `waitUntil` 的语义是
 * 「响应返回后，平台继续替你把任务跑完才释放该请求」：
 *
 *   - `waitUntil` 的容忍上限是 **约 30 秒**（远小于这里的 120 秒）；
 *   - 于是**每个播放请求**都会被硬生生拖满 30 秒才结束；
 *   - 超过上限后平台取消任务并打出：
 *     `waitUntil() tasks did not complete within the allowed time
 *      after invocation end and have been cancelled`
 *
 * ## 线上实测（铁证）
 *
 * `wrangler tail` 抓到三条 `.cas` 播放请求（均已命中直链缓存 `reused=true`，
 * 也就是说 302 早已就绪、**不需要任何网络等待**）：
 *
 *     [GET] 302  cpu=84ms  wall=34033ms   ← 302 早就好了，被 waitUntil 拖了 34 秒
 *     [GET] 302  cpu=86ms  wall=34910ms
 *     [GET] 302  cpu=54ms  wall=32085ms
 *
 * 三条全部 `outcome=ok`、零报错，但客户端要等 30+ 秒。
 * 网易爆米花等不到这么久 → 报「WebDAV 地址错误」（文案极具误导性）。
 *
 * 同时解释了两个此前无法理解的现象：
 *   1. **过几分钟自己就好了** —— TEMP 被定时任务清空后，清理任务变轻，
 *      累积的拖慢效应消失，于是"自愈"；
 *   2. **播放时好时坏** —— TEMP 里副本越多，删除时的列目录越慢，
 *      越接近播放器的超时线。
 *
 * ## 正确做法
 *
 * 清理**纯属后台事务**，与「把 302 交给播放器」毫无关系，绝不能占用请求时间：
 *   - 这里只发起**不挂 waitUntil** 的 fire-and-forget 任务（尽力而为）；
 *   - 真正的兜底由 worker 的 `scheduled` 定时任务 `sweepTempFilesAll()`
 *     完成，那条路径不受请求生命周期约束，才是可靠的那一条。
 */
function scheduleCleanup(
  client: Yun139ApiClient,
  fileId: string,
  delayMs: number,
): void {
  // ⚠️ 即使 `__cas_ctx__` 存在也**不要**注册 waitUntil：
  //    120 秒的延时任务必然超出平台约 30 秒的容忍上限，只会拖死本次请求。
  //    这里显式读取后忽略，防止后人"顺手"又把它挂上去。
  void (globalThis as any).__cas_ctx__

  // fire-and-forget：延迟删除，尽力而为；失败与超时都不影响播放，
  // 漏删的副本由定时任务兜底清理。
  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, delayMs))
      await safeDelete(client, fileId)
    } catch {
      // 忽略：清理失败不是错误，定时任务会兜底
    }
  })()
}
