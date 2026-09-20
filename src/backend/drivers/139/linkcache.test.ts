/**
 * 139 直链 / 目录缓存回归测试。
 *
 * ## 背景（2026-09-20 线上，两个连续踩到的坑）
 *
 * 用户反馈「网易爆米花播放大部分报 WEBDAV 地址错误，同一部电影时好时坏」。
 * 实测定位：服务端**不返回错误**，是**慢** ——
 *
 *   - 同一 `.strm` 连打 10 次全部 200，耗时 1.1 ~ 8.3 秒；
 *   - 其播放地址（302 到 139 直链）8 次全部 302，耗时 2.0 ~ 13.9 秒；
 *   - `wrangler tail`：CPU 仅 64~160ms、零异常 ⇒ 时间全在等 139 往返。
 *
 * 客户端等不及就报「地址错误」；取不到 `.strm` 内容时 `raw.ts` 主动返回
 * 503 —— 这就是「重试又能进」的来源。
 *
 * 于是给直链与目录列表加缓存。**连踩两个坑，都必须被本文件锁死**：
 *
 * ### 坑 1：缓存不能写主 KV
 *
 * 首版写进 `openlist-tsworkers-kv`，线上直接报：
 *
 *     KV put() limit exceeded for the day
 *
 * CF 免费版 KV **每天仅 1000 次写**。一次 `.strm` 请求要解析 3 层目录、
 * 每层写一个 key ⇒ 三百多次请求就把当日配额打爆。症状极度迷惑：配额
 * 没满时偶尔命中（1 秒返回），写满后**全部静默失效**（回到 5~8 秒）。
 *
 * 契约：必须用 **Cache API**（`caches.default`），它不消耗 KV 写入配额。
 *
 * ### 坑 2：底层驱动的运行时上下文必须显式注入
 *
 * `injectRuntimeContext` 只在 `getDriver()` 的**调用点**执行，作用于当前
 * 请求的驱动。而 strm 驱动在 init 里**内部**又调了一次 `getDriver()` 拿到
 * 139 实例，那次没有注入 ⇒ `storageId` / `env` 恒为 undefined。
 * 实测日志：`listFiles ... sid=1 env=Y` 说明注入补齐后才正常。
 *
 * 契约：`strm/driver.ts` 的 `listRemote` 必须给底层驱动补 `setRuntimeContext`。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

const read = (rel: string) =>
  fs.readFile(new URL(rel, import.meta.url), "utf8")

test("linkcache: 必须用 Cache API 而非主 KV（KV 有每日 1000 次写配额）", async () => {
  const src = await read("./linkcache.ts")
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

  assert.ok(
    /caches\?\.default|caches\.default/.test(code),
    "必须使用 caches.default（Cache API）作为跨 isolate 缓存",
  )
  assert.ok(
    !/\.put\(/.test(code) || !/kv\.put\(/.test(code),
    "不得对主 KV 做 put —— 会撞上每日写入配额（KV put() limit exceeded）",
  )
  assert.ok(
    !/getKvBinding/.test(code),
    "不得依赖 getKvBinding 写缓存（那是主 KV 路径，配额会被打爆）",
  )
})

test("linkcache: Cache API 读必须限时（纯优化不得拖慢主流程）", async () => {
  const src = await read("./linkcache.ts")
  const fn = src.match(/async function cacheGet[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 cacheGet 实现")
  assert.ok(
    /withTimeout/.test(fn![0]),
    "cacheGet 必须用 withTimeout 限时，否则缓存挂起会拖死整个请求",
  )
})

test("linkcache: 缓存键必须含存储隔离 scope（防多存储串用 fileId）", async () => {
  const src = await read("./linkcache.ts")
  assert.ok(
    /function storageScope/.test(src),
    "必须有 storageScope 做存储隔离",
  )
  // cacheKeyUrl 必须把 scope 编进路径
  const fn = src.match(/function cacheKeyUrl[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 cacheKeyUrl 实现")
  assert.ok(
    /scope/.test(fn![0]),
    "cacheKeyUrl 必须把 scope 编入 URL 路径，否则不同存储会互相串用缓存",
  )
})

test("linkcache: 直链 TTL 不得超过 139 签名有效期 900s", async () => {
  const src = await read("./linkcache.ts")
  const m = src.match(/LINK_TTL_MS\s*=\s*([^\/\n]+)/)
  assert.ok(m, "应能找到 LINK_TTL_MS 常量")
  // 139 直链带 X-Amz-Expires=900（15 分钟），缓存必须留足余量
  const expr = m![1].trim()
  if (/^\d+\s*\*\s*60\s*\*\s*1000$/.test(expr)) {
    const mins = Number(expr.split("*")[0].trim())
    assert.ok(
      mins <= 12,
      `直链缓存不得超过 12 分钟（139 签名仅 900s），实际 ${mins} 分钟`,
    )
  } else {
    assert.fail(`LINK_TTL_MS 应写成 N * 60 * 1000 形式，实际: ${expr}`)
  }
})

test("strm: listRemote 必须给底层驱动补注入运行时上下文", async () => {
  // 见文件头「坑 2」：injectRuntimeContext 只作用于 getDriver 调用点的驱动，
  // strm 内部再次 getDriver 拿到的 139 实例不会被注入 ⇒ 缓存拿不到
  // storageId/env ⇒ 缓存键失去隔离、且写不进 Cache API。
  const src = await read("../strm/driver.ts")
  const fn = src.match(/private async listRemote[\s\S]*?\n  \}/)
  assert.ok(fn, "应能找到 listRemote 实现")
  assert.ok(
    /setRuntimeContext/.test(fn![0]),
    "listRemote 必须显式给底层驱动 setRuntimeContext（storageId + env）",
  )
  assert.ok(
    /getEnvCtx/.test(fn![0]),
    "listRemote 注入的 env 应来自 getEnvCtx()（由 index.ts 中间件每请求写入）",
  )
})

test("139 driver: setRuntimeContext 必须把 storageId/env 透传给 API client", async () => {
  // 缓存（linkcache）在 client 层做存储隔离，因此驱动收到上下文后
  // 必须同步给 client，否则 client.storageId 恒为 undefined。
  const src = await read("./driver.ts")
  const fn = src.match(/setRuntimeContext\([\s\S]*?\n  \}/)
  assert.ok(fn, "应能找到 setRuntimeContext 实现")
  assert.ok(
    /this\.client\.storageId\s*=/.test(fn![0]),
    "setRuntimeContext 必须把 storageId 同步给 client（缓存做存储隔离要用）",
  )
})

test("139 client: getDownloadUrl 必须走缓存，且缓存键含 fileId", async () => {
  const src = await read("./util.ts")
  // 注意：调用点带泛型参数（如 `getCachedList<ListResult>(`），
  // 故正则用 `\s*[<(]` 兼容 `(` 与 `<`。
  assert.ok(
    /getCachedLink\s*[<(]/.test(src) && /setCachedLink\s*\(/.test(src),
    "getDownloadUrl 必须读写直链缓存",
  )
  assert.ok(
    /getCachedList\s*[<(]/.test(src) && /setCachedList\s*\(/.test(src),
    "listFiles 必须读写目录列表缓存",
  )
  // 回源逻辑必须被拆到独立方法，避免缓存命中时仍走网络
  assert.ok(
    /fetchDownloadUrl\s*\(/.test(src),
    "回源取直链必须拆成 fetchDownloadUrl，由 getDownloadUrl 先查缓存再调用",
  )
  assert.ok(
    /fetchListFiles\s*\(/.test(src),
    "回源列目录必须拆成 fetchListFiles，由 listFiles 先查缓存再调用",
  )
})

/**
 * 回归测试：CAS 清理任务**绝不能**注册到 `ctx.waitUntil`。
 *
 * ## 背景（2026-09-20 线上定位，播放卡 30+ 秒的元凶）
 *
 * 清理任务是「延时 120 秒后删除 TEMP 副本」，而 Cloudflare Workers 的
 * `ctx.waitUntil` 容忍上限约 **30 秒**。把它注册上去的后果是：
 * **每个播放请求都会被平台拖满 30 秒才结束**，即使 302 早已就绪。
 *
 * `wrangler tail` 实测（三条均已命中缓存，无需任何网络等待）：
 *
 *     [GET] 302  cpu=84ms  wall=34033ms
 *     [GET] 302  cpu=86ms  wall=34910ms
 *     [GET] 302  cpu=54ms  wall=32085ms
 *
 * 客户端（网易爆米花）等不到 30 秒 → 报「WebDAV 地址错误」；
 * TEMP 被定时任务清空后又"自愈"，表现为**时好时坏 + 过几分钟恢复**。
 *
 * 这个 bug 极其隐蔽：所有请求都 `outcome=ok`、零报错，只是慢。
 * 因此用测试把契约钉死：清理必须彻底脱离请求生命周期，
 * 由 worker 的 `scheduled` 定时任务 `sweepTempFilesAll()` 兜底。
 */
test("139 CAS: 清理任务绝不能注册到 ctx.waitUntil（会拖死每个播放请求）", async () => {
  const src = await read("./cas/player.ts")
  const fn = src.match(/function scheduleCleanup[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 scheduleCleanup 实现")
  assert.ok(
    !/ctx\.waitUntil\s*\(/.test(fn![0]),
    "scheduleCleanup 不得调用 ctx.waitUntil —— 120 秒任务超出平台约 30 秒上限，会拖死请求",
  )
  assert.ok(
    /waitUntil/.test(fn![0]),
    "应保留说明性注释，讲清为何不能用 waitUntil（防止后人改回去）",
  )
})

test("139 CAS: 定时任务 sweepTempFilesAll 必须存在（清理的真正兜底）", async () => {
  const restoreSrc = await read("./cas/restore.ts")
  assert.ok(
    /export async function sweepTempFilesAll/.test(restoreSrc),
    "清理脱离请求生命周期后，必须由 sweepTempFilesAll 兜底，否则 TEMP 会无限膨胀",
  )
  const workerSrc = await read("../../worker.ts")
  assert.ok(
    /sweepTempFilesAll/.test(workerSrc),
    "worker 的 scheduled 必须调用 sweepTempFilesAll",
  )
})
