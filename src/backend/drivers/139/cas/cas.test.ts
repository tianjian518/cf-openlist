/**
 * CAS 模块自测
 *
 * 覆盖：文件名推导、元数据编解码、扩展名白名单、秒传分片计算。
 * 运行：npx tsx --test src/backend/drivers/139/cas/cas.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  deriveRealName,
  decodeCas,
  encodeCas,
  extAllowed,
  isCasName,
  normalizeAllowlist,
  toCasName,
} from "./format"
import { buildPartInfos, sweepTempFilesAll } from "./restore"
import {
  shouldHandleCas,
  clearCasLinkCache,
  resolveCasPlayLink,
} from "./player"

/* ------------------------- 文件名 ------------------------- */

test("isCasName 识别 .cas 后缀（大小写不敏感）", () => {
  assert.equal(isCasName("movie.mp4.cas"), true)
  assert.equal(isCasName("movie.MP4.CAS"), true)
  assert.equal(isCasName("movie.mp4"), false)
  assert.equal(isCasName("cas"), false)
})

test("toCasName / deriveRealName 互为逆运算", () => {
  const real = "流浪地球2.2023.2160p.mp4"
  assert.equal(toCasName(real), `${real}.cas`)
  assert.equal(deriveRealName(toCasName(real)), real)
})

test("deriveRealName 在退化命名时回退到元数据 name", () => {
  // 文件名只剩 movie.cas，无内层扩展名
  assert.equal(deriveRealName("movie.cas", "movie.mkv"), "movie.mkv")
  // 元数据也没有扩展名时，保持原样
  assert.equal(deriveRealName("movie.cas", undefined), "movie")
  // 内层有扩展名时以文件名为准，忽略元数据
  assert.equal(deriveRealName("a.mp4.cas", "b.mkv"), "a.mp4")
})

/* ------------------------- 编解码 ------------------------- */

const SAMPLE = {
  name: "测试影片.mkv",
  size: 8_589_934_592,
  md5: "d41d8cd98f00b204e9800998ecf8427e",
  sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  sha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  provider: "139",
}

test("encodeCas → decodeCas 往返一致", () => {
  const encoded = encodeCas(SAMPLE)
  const decoded = decodeCas(encoded)

  assert.equal(decoded.name, SAMPLE.name)
  assert.equal(decoded.size, SAMPLE.size)
  assert.equal(decoded.md5, SAMPLE.md5)
  assert.equal(decoded.sha1, SAMPLE.sha1)
  assert.equal(decoded.sha256, SAMPLE.sha256)
  assert.equal(decoded.provider, SAMPLE.provider)
})

test("encodeCas 产物是合法 base64 且可解析为 JSON", () => {
  const encoded = encodeCas(SAMPLE)
  // 注意：atob 得到的是 latin1 字符串，含中文时需再按 UTF-8 解一遍
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
  const json = JSON.parse(new TextDecoder().decode(bytes))
  assert.equal(json.name, SAMPLE.name)
  assert.equal(json.size, SAMPLE.size)
  // 落盘字段名用 preID，与既有工具链保持一致
  assert.ok("create_time" in json)
})

test("decodeCas 兼容缺失 padding 的 base64", () => {
  const encoded = encodeCas(SAMPLE)
  const stripped = encoded.replace(/=+$/, "")
  const decoded = decodeCas(stripped)
  assert.equal(decoded.name, SAMPLE.name)
})

test("decodeCas 兼容首尾空白与 Uint8Array 输入", () => {
  const encoded = encodeCas(SAMPLE)
  assert.equal(decodeCas(`\n  ${encoded}  \n`).name, SAMPLE.name)

  const bytes = new TextEncoder().encode(encoded)
  assert.equal(decodeCas(bytes).name, SAMPLE.name)
  assert.equal(decodeCas(bytes.buffer).name, SAMPLE.name)
})

test("decodeCas 拒绝空内容 / 非 base64 / 非 JSON", () => {
  assert.throws(() => decodeCas(""), /为空/)
  assert.throws(() => decodeCas("   "), /为空/)
  assert.throws(() => decodeCas("这不是base64!!!"), /base64|JSON/)
})

test("decodeCas 校验必需字段", () => {
  const noName = btoa(JSON.stringify({ size: 1, md5: "x" }))
  assert.throws(() => decodeCas(noName), /name/)

  const badSize = btoa(JSON.stringify({ name: "a.mp4", size: -1, md5: "x" }))
  assert.throws(() => decodeCas(badSize), /size/)

  const noHash = btoa(JSON.stringify({ name: "a.mp4", size: 1 }))
  assert.throws(() => decodeCas(noHash), /哈希/)
})

test("encodeCas 缺少 name 时抛错", () => {
  assert.throws(() => encodeCas({ name: "", size: 1 }), /name/)
})

test("decodeCas 将 preID 映射为 preId", () => {
  const raw = btoa(
    JSON.stringify({ name: "a.mp4", size: 1, md5: "m", preID: "P-123" }),
  )
  assert.equal(decodeCas(raw).preId, "P-123")
})

test("sliceMd5 缺失时回落为 md5", () => {
  const raw = btoa(JSON.stringify({ name: "a.mp4", size: 1, md5: "MMM" }))
  assert.equal(decodeCas(raw).sliceMd5, "MMM")
})

/* ------------------------- 白名单 ------------------------- */

test("normalizeAllowlist 清洗分隔符、点号与大小写", () => {
  assert.equal(normalizeAllowlist(".MP4, .MKV ;ts"), "mp4,mkv,ts")
  assert.equal(normalizeAllowlist("mp4 mp4 mkv"), "mp4,mkv")
  assert.equal(normalizeAllowlist(""), "")
})

test("normalizeAllowlist 遇 * 返回通配", () => {
  assert.equal(normalizeAllowlist("mp4,*"), "*")
  assert.equal(normalizeAllowlist("*"), "*")
})

test("extAllowed 空白名单表示全部放行", () => {
  assert.equal(extAllowed("a.anything", ""), true)
  assert.equal(extAllowed("a", ""), true)
})

test("extAllowed 命中也大小写不敏感", () => {
  assert.equal(extAllowed("a.MP4", "mp4,mkv"), true)
  assert.equal(extAllowed("a.mkv", "mp4,mkv"), true)
  assert.equal(extAllowed("a.avi", "mp4,mkv"), false)
  assert.equal(extAllowed("noext", "mp4"), false)
})

test("extAllowed 通配放行全部", () => {
  assert.equal(extAllowed("a.xyz", "*"), true)
})

/* --------------------- shouldHandleCas --------------------- */

test("shouldHandleCas 只接管 .cas 且内层是视频", () => {
  assert.equal(shouldHandleCas("movie.mp4.cas"), true)
  assert.equal(shouldHandleCas("movie.mkv.cas"), true)
  assert.equal(shouldHandleCas("movie.TS.cas"), true)
  // 内层不是视频 → 不接管，交给普通下载
  assert.equal(shouldHandleCas("doc.pdf.cas"), false)
  // 非 .cas → 不接管
  assert.equal(shouldHandleCas("movie.mp4"), false)
})

test("shouldHandleCas 尊重自定义白名单", () => {
  assert.equal(shouldHandleCas("book.epub.cas", "epub"), true)
  assert.equal(shouldHandleCas("movie.mp4.cas", "epub"), false)
  // 通配时全部接管
  assert.equal(shouldHandleCas("anything.bin.cas", "*"), true)
})

/* --------------------- 秒传分片计算 --------------------- */

test("buildPartInfos 小文件单分片", () => {
  const parts = buildPartInfos(1024)
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0], { partNumber: 1, partSize: 1024 })
})

test("buildPartInfos 单分片边界（100MB）", () => {
  // SLICE_SIZE = 100MB：恰好 100MB 是 1 片，多 1 字节就要 2 片
  const slice = 100 * 1024 * 1024
  assert.equal(buildPartInfos(slice).length, 1)
  assert.equal(buildPartInfos(slice + 1).length, 2)
})

test("buildPartInfos 分片号递增且总和不超 size", () => {
  // 250MB+777B：100 + 100 + 50MB+777 → 3 片
  const size = 250 * 1024 * 1024 + 777
  const parts = buildPartInfos(size)
  assert.equal(parts.length, 3)
  parts.forEach((p, i) => assert.equal(p.partNumber, i + 1))
  const total = parts.reduce((s, p) => s + p.partSize, 0)
  assert.equal(total, size)
})

test("buildPartInfos 超过 30GB 阈值改用 512MB 大分片", () => {
  // LARGE_FILE_THRESHOLD = 30GB；阈值内用 100MB，超过后用 512MB
  const under = 30 * 1024 * 1024 * 1024 // 恰好 30GB，仍属普通分片
  const over = 40 * 1024 * 1024 * 1024 // 40GB → 512MB 分片
  assert.equal(buildPartInfos(under)[0].partSize, 100 * 1024 * 1024)
  assert.equal(buildPartInfos(over)[0].partSize, 512 * 1024 * 1024)
})

test("buildPartInfos 空文件也返回一个分片", () => {
  const parts = buildPartInfos(0)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].partSize, 0)
})

test("buildPartInfos 分片数封顶 100", () => {
  // 2GB → ceil(2GB / 100MB) = 21 片（未封顶）
  assert.equal(buildPartInfos(2 * 1024 * 1024 * 1024).length, 21)
  // 10GB → 102 片会被截到上限 100
  assert.equal(buildPartInfos(10 * 1024 * 1024 * 1024).length, 100)
  // 再大也不会超过上限（云端限制 MAX_PART_INFOS = 100）
  assert.equal(buildPartInfos(20 * 1024 * 1024 * 1024).length, 100)
})

/* --------------------- 定时清扫（sweepTempFilesAll） --------------------- */

/**
 * 构造一个假的 139 client：
 * - listFiles(root)      → 返回 TEMP 目录
 * - listFiles(tempDirId) → 返回待清理文件
 * - request(batchTrash)  → 记录被删除的 fileId
 */
function makeFakeClient(files: Array<{ contentID: string; contentName: string }>) {
  const deleted: string[] = []
  const client: any = {
    async listFiles(id: string) {
      if (id === "TEMP_ID") return { folders: [], files }
      return { folders: [{ catalogName: "TEMP", catalogID: "TEMP_ID" }], files: [] }
    },
    async request(path: string, body: any) {
      if (path === "/recyclebin/batchTrash") {
        deleted.push(...body.fileIds)
      }
      return {}
    },
  }
  return { client, deleted }
}

test("sweepTempFilesAll 清空全部带前缀的临时副本", async () => {
  const { client, deleted } = makeFakeClient([
    { contentID: "f1", contentName: "TEMP_139CAS_1700000000_abc_影片.mp4" },
    { contentID: "f2", contentName: "TEMP_139CAS_1700000001_def_剧集.mkv" },
    // 刚生成的副本也在清理范围内（定时任务场景不会误删正在播放的）
    {
      contentID: "f3",
      contentName: `TEMP_139CAS_${Date.now()}_ghi_新片.mp4`,
    },
  ])

  const removed = await sweepTempFilesAll(client, "/")
  assert.equal(removed, 3)
  assert.deepEqual(deleted.sort(), ["f1", "f2", "f3"])
})

test("sweepTempFilesAll 绝不触碰非本前缀的文件（保护 NAS 等共存数据）", async () => {
  const { client, deleted } = makeFakeClient([
    { contentID: "mine1", contentName: "TEMP_139CAS_1700000000_a_x.mp4" },
    // NAS（Go 版）产生的文件：前缀不是 TEMP_139CAS_
    { contentID: "nas1", contentName: "TEMP_1700000000_b_y.mp4" },
    // 用户手动放进去的文件
    { contentID: "user1", contentName: "我的备份.mp4" },
    // 形似但前缀不完整，也必须放过
    { contentID: "fake1", contentName: "TEMP_139CASX_1700_z.mp4" },
  ])

  const removed = await sweepTempFilesAll(client, "/")
  assert.equal(removed, 1)
  assert.deepEqual(deleted, ["mine1"])
})

test("sweepTempFilesAll 遵守 maxCount 上限，避免单次超时", async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    contentID: `c${i}`,
    contentName: `TEMP_139CAS_17000000${i}_x_f${i}.mp4`,
  }))
  const { client, deleted } = makeFakeClient(files)

  const removed = await sweepTempFilesAll(client, "/", 3)
  assert.equal(removed, 3)
  assert.equal(deleted.length, 3)
})

test("sweepTempFilesAll 在接口异常时静默返回 0（不影响用户请求）", async () => {
  const client: any = {
    async listFiles() {
      throw new Error("network down")
    },
  }
  const removed = await sweepTempFilesAll(client, "/")
  assert.equal(removed, 0)
})

test("sweepTempFilesAll 跳过没有 contentID 的条目", async () => {
  const { client, deleted } = makeFakeClient([
    { contentID: "", contentName: "TEMP_139CAS_1700000000_a_x.mp4" },
    { contentID: "ok", contentName: "TEMP_139CAS_1700000000_b_y.mp4" },
  ])

  const removed = await sweepTempFilesAll(client, "/")
  assert.equal(removed, 1)
  assert.deepEqual(deleted, ["ok"])
})

/* -------------------- CAS 直链缓存（治播放慢 / 503） -------------------- */

/** 构造一个可计数的假 139 客户端，用于观察缓存是否真的省掉了往返 */
function makeCountableClient() {
  const calls = { downloadUrl: 0, request: 0 }
  // `.cas` 内容是 base64(JSON)，必须用 encodeCas 生成合法桩数据
  const casContent = encodeCas({
    name: "movie.mkv",
    size: 1234,
    sha256: "a".repeat(64),
  } as any)
  const client: any = {
    async getDownloadUrl() {
      calls.downloadUrl++
      return "https://cdn.example.com/cas"
    },
    async listFiles() {
      return { folders: [{ id: "temp-1", name: "TEMP" }], files: [] }
    },
    async request() {
      calls.request++
      return { data: { exist: true, rapidUpload: true, fileId: "real-1" } }
    },
  }
  return { client, calls, casContent }
}

test("resolveCasPlayLink 二次调用命中缓存，不再发起任何网络往返", async () => {
  // 线上 503 的核心成因：播放器会为起播/拖动/分段反复请求同一文件，
  // 每次都要串行走 4 次网络请求（实测 3~13 秒），很快耗尽 Workers 的
  // 子请求与 CPU 配额。直链有效期约 15 分钟，缓存后可零成本复用。
  clearCasLinkCache()

  const { client, calls, casContent } = makeCountableClient()
  // 打桩 fetch（readCasContent 用它读 .cas 内容）
  const realFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return new Response(casContent, { status: 200 })
  }) as any

  try {
    const opts = {
      client,
      rootId: "/",
      casFileId: "cas-1",
      casName: "movie.mkv.cas",
      autoCleanup: false,
    }
    const first = await resolveCasPlayLink(opts as any)
    const afterFirst = { ...calls, fetchCount }

    const second = await resolveCasPlayLink(opts as any)

    // 第二次必须与第一次返回同一条直链
    assert.equal(second.url, first.url, "二次调用应命中缓存返回同一 URL")

    // 关键断言：网络往返数完全没有增长
    assert.deepEqual(
      { ...calls, fetchCount },
      afterFirst,
      `缓存命中不应产生任何网络往返，实际变化: ${
        JSON.stringify({ ...calls, fetchCount })
      } vs ${JSON.stringify(afterFirst)}`,
    )
  } finally {
    globalThis.fetch = realFetch
    clearCasLinkCache()
  }
})

test("直链缓存必须走 Cache API 共享（仅内存 Map 在 CF 上无效）", async () => {
  // ⚠️ 这是本缓存实现的**核心回归点**，用血泪换来：
  //
  // ① 最初用模块级 `Map` 做缓存，实测**完全无效** —— 同一 URL 连打 10 次
  //    HEAD，耗时 3.3/4.2/5.0/8.3/9.0/10.0/11.6/12.8/13.2 秒，毫无收敛趋势。
  //    原因是 CF Workers 按负载把请求分散到**多个 isolate**，模块级状态
  //    不跨 isolate 共享，于是"刚写入的直链"下次请求根本读不到。
  //
  // ② 后来改用 **KV**，线上**依然不命中**。决定性证据：
  //       GET .../kv/namespaces/<主KV>/keys?prefix=caslink:  →  0 条
  //    代码明明 `await kv.put("caslink:" + id, ...)`，线上一个键都没有 ——
  //    CF 免费版 KV **每天仅 1000 次写入**，与主配置共用同一 KV，几百次
  //    播放即打满配额，`put` 全部失败且被 catch 静默吞掉。
  //
  // 因此契约是：缓存**必须**读写 Cache API（跨 isolate 共享、**零写配额**），
  // 内存 Map 只能作为一级加速层存在。
  //
  // ⚠️ 本测试**不得**再打桩 KV —— 一旦实现回退到 KV，此测试必须失败。
  const { client, casContent } = makeCountableClient()

  // 打桩一个最小 Cache API，记录读写次数
  const cacheCalls = { match: 0, put: 0 }
  const store = new Map<string, string>()
  const fakeCache = {
    async match(key: string) {
      cacheCalls.match++
      const body = store.get(key)
      return body === undefined ? undefined : new Response(body, { status: 200 })
    },
    async put(key: string, res: Response) {
      cacheCalls.put++
      store.set(key, await res.text())
    },
  }
  const realCaches = (globalThis as any).caches
  ;(globalThis as any).caches = { default: fakeCache }

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(casContent, { status: 200 })) as any

  try {
    clearCasLinkCache()
    await resolveCasPlayLink({
      client,
      rootId: "/",
      casFileId: "cas-cache-1",
      casName: "movie.mkv.cas",
      autoCleanup: false,
    } as any)

    // 首次：链路跑完后必须把直链写进 Cache API
    assert.ok(
      cacheCalls.put >= 1,
      `首次播放后应向 Cache API 写入直链，实际 put=${cacheCalls.put}`,
    )

    // 清掉内存一级缓存，模拟"请求被分派到另一个 isolate"
    clearCasLinkCache()
    const before = { ...cacheCalls }

    await resolveCasPlayLink({
      client,
      rootId: "/",
      casFileId: "cas-cache-1",
      casName: "movie.mkv.cas",
      autoCleanup: false,
    } as any)

    assert.ok(
      cacheCalls.match > before.match,
      `跨 isolate 必须回落到 Cache API 读取，实际 match 增量=${cacheCalls.match - before.match}`,
    )
  } finally {
    globalThis.fetch = realFetch
    clearCasLinkCache()
    ;(globalThis as any).caches = realCaches
  }
})

test("resolveCasPlayLink 失败结果绝不进缓存", async () => {
  // 若把失败也缓存，用户会在 TTL 内**持续**拿到不可播放的直链，
  // 且要等 10 分钟才自愈 —— 比不缓存更糟。此处锁定该契约。
  clearCasLinkCache()

  const client: any = {
    async getDownloadUrl() {
      throw new Error("cdc down")
    },
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response("boom", { status: 500 })) as any

  try {
    await assert.rejects(
      () =>
        resolveCasPlayLink({
          client,
          rootId: "/",
          casFileId: "cas-fail",
          casName: "movie.mkv.cas",
          autoCleanup: false,
        } as any),
      /step=read/,
      "读 CAS 失败应抛 CasPlayError 且带 step 标记",
    )
  } finally {
    globalThis.fetch = realFetch
    clearCasLinkCache()
  }
})

/* ------------------ 临时副本复用（TEMP 堆积的根因） ------------------ */

test("播放恢复必须优先复用 TEMP 里已有的同名副本（否则每次新建一份）", async () => {
  // 真实故障（2026-09-18 线上，TEMP 目录堆了 11 个同名副本）：
  //
  // 播放器起播探测 / 拖动 / 分段 Range 会对同一个 .cas 反复请求，
  // 每次请求都跑一遍秒传恢复 → 在 TEMP 里**新建一个副本**。
  // 而请求级清理（waitUntil 120s）因 ctx 未注入而从不执行，
  // cron 又要等下一小时 —— 副本就这样堆积起来。
  //
  // 连锁后果：① 每次请求都真跑秒传恢复，耗时稳定 7~12 秒；
  //          ② TEMP 膨胀使 listFiles 变慢，最终拖死请求（120s 超时 / 503）。
  //
  // 契约：TEMP 中已存在「前缀合规 + 后缀同名」的副本时，必须直接复用，
  //       不得再调用秒传恢复接口。
  const realName = "冰川时代：幸存的希德.2008.mkv"
  const calls = { rapid: 0 }
  const reusedId = "existing-copy-id"

  const client: any = {
    // readCasContent 会先取一次 .cas 自身直链再 fetch（fetch 已被打桩）
    async getDownloadUrl() {
      return "https://example.invalid/cas.cas"
    },
    async listFiles(id: string) {
      if (id === "TEMP_ID") {
        return {
          folders: [],
          files: [
            {
              contentID: reusedId,
              contentName: `TEMP_139CAS_1789709748945_y3cl59_${realName}`,
            },
          ],
        }
      }
      return {
        folders: [{ catalogName: "TEMP", catalogID: "TEMP_ID" }],
        files: [],
      }
    },
    async request(path: string) {
      if (path.includes("rapid")) calls.rapid++
      return { data: {} }
    },
  }

  const content = encodeCas({
    name: realName,
    size: 1024 * 1024,
    sha256: "a".repeat(64),
  } as any)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(content, { status: 200 })) as any

  try {
    const link = await resolveCasPlayLink({
      client,
      rootId: "/",
      casFileId: "cas-reuse-1",
      casName: `${realName}.cas`,
      autoCleanup: false,
    } as any)

    assert.equal(
      calls.rapid,
      0,
      `TEMP 已有同名副本时必须复用，不得再走秒传恢复（实际调用 ${calls.rapid} 次）`,
    )
    assert.equal(
      link.tempDirId,
      "TEMP_ID",
      "复用路径也要回传 tempDirId，供后续请求继续复用",
    )
  } finally {
    globalThis.fetch = realFetch
    clearCasLinkCache()
  }
})

test("必须注入 __cas_ctx__ 供临时副本延迟清理（否则 waitUntil 恒被丢弃）", async () => {
  // `scheduleCleanup()` 读的是 `globalThis.__cas_ctx__`，取值恒 undefined 时
  // 会走 else 分支把任务直接丢掉 —— 这就是"清理从不生效"的直接原因。
  // 契约：请求中间件必须把 Hono 的 executionCtx 挂到该全局上。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../../index.ts", import.meta.url), "utf8"),
  )
  assert.ok(
    /__cas_ctx__/.test(src),
    "index.ts 必须在请求入口注入 __cas_ctx__（否则请求级清理永不执行）",
  )
  assert.ok(
    /executionCtx/.test(src),
    "应通过 Hono 的 c.executionCtx 取 ExecutionContext",
  )
})
