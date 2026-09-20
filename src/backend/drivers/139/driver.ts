import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Yun139Addition } from "./types"
import { Yun139ApiClient } from "./util"
import {
  resolveCasPlayLink,
  shouldHandleCas,
  readCasContent,
  parseCasMeta,
  deriveRealName as deriveCasRealName,
  extAllowed as casExtAllowed,
  isCasName,
} from "./cas"
import {
  flushPathIndex,
  joinIndexPath,
  lookupPathId,
  lookupFirstHit,
  normalizeIndexPath,
  rememberChildren,
  rememberPathId,
  type PathIndexOptions,
} from "./pathindex"

export class Yun139Driver implements StorageDriver {
  private addition: Yun139Addition
  private client: Yun139ApiClient
  /** 存储 id（用于隔离索引），由 storage.ts 在构造后注入 */
  private storageId?: string | number
  /** 运行环境上下文，索引落盘时用 */
  private envCtx?: any
  /**
   * 临时目录（TEMP）的 ID 缓存。
   *
   * 播放时要往 TEMP 写秒传副本，而查找 TEMP 需要先列一次根目录。
   * 缓存后同一 isolate 内的后续播放可省掉这次往返 —— 播放是延迟敏感
   * 路径，Workers 的子请求与 CPU 时间都有硬限制，超出会被拒绝（503）。
   */
  private tempDirId?: string

  constructor(addition: Yun139Addition) {
    this.addition = addition
    this.client = new Yun139ApiClient(addition)
  }

  /**
   * 注入运行时上下文（存储 id / env）。
   *
   * 索引需要按存储隔离并把数据落到 KV，但驱动构造签名由 OpenList 决定、
   * 无法扩张，因此用可选注入的方式传入。
   */
  setRuntimeContext(ctx: { storageId?: string | number; env?: any }): void {
    if (ctx.storageId !== undefined) this.storageId = ctx.storageId
    if (ctx.env !== undefined) this.envCtx = ctx.env
    // ⚠️ 必须把 storageId / env 同步给 API client。
    //
    // 直链与目录缓存（`linkcache.ts`）需要 storageId 做**存储隔离** ——
    // 同一账号可挂多个存储（root_folder_id 不同），若缓存键不含 storageId，
    // A 存储的 fileId 会命中 B 存储的直链，取到**别人的文件**。
    // env 用于访问 KV（跨 isolate 复用缓存，否则进程内缓存在机房漂移下
    // 几乎不命中，优化形同虚设）。
    this.client.storageId = this.storageId
    this.client.env = this.envCtx
  }

  /** 索引操作所需的公共参数 */
  private indexOpts(): PathIndexOptions {
    return {
      addition: this.addition,
      storageId: this.storageId,
      env: this.envCtx,
    }
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /** 请求结束前把索引落盘（由 storage.ts 在 flushPendingDriverState 时调用） */
  async flushState(): Promise<void> {
    await flushPathIndex(this.envCtx)
  }

  private cleanPath(p: string): string {
    return normalizeIndexPath(p)
  }

  private getRootId(): string {
    if (this.addition.root_folder_id) {
      return this.addition.root_folder_id
    }
    return this.client.isPersonalNew() ? "/" : ""
  }

  /**
   * 把路径解析为目录 ID。
   *
   * ## 核心优化
   *
   * 139 只认 fileId、不认路径，传统实现只能从根目录逐层向下问，
   * 成本随深度线性增长（点开第 N 层 = N 次串行请求），并容易撞上
   * Workers 的子请求/并发上限（表现为边缘 503）。
   *
   * 这里引入**路径索引**（见 ./pathindex.ts）：
   *   1. 先查索引，命中则直接返回，**0 次请求**
   *   2. 未命中才逐层解析，且每解析一层就**登记**该层（供下次命中）
   *
   * 由于列目录时子目录的名字与 ID 都是白送的（`/file/list` 响应自带），
   * `list()` 会调用 `rememberChildren` 预填下一层的 ID。
   * 顺着一层层点下去时，解析次数趋近于 0——**解析成本不再随深度增长**。
   */
  private async resolveCatalogId(physicalPath: string): Promise<string> {
    const clean = this.cleanPath(physicalPath)
    if (clean === "/") {
      return this.getRootId()
    }

    // ① 索引命中：直接返回，不产生任何网络请求
    const hit = await lookupPathId(clean, this.indexOpts())
    if (hit) return hit

    // ② 未命中：逐层解析，并把沿途每一层登记进索引
    const parts = clean.split("/").filter(Boolean)

    /**
     * 最多解析的层数上限。
     *
     * 深层目录理论上需要 N 次请求，但 Workers 每请求子请求数有限
     * （免费版 50 次，且并发出站连接仅 6 条）。这里设一个上限：
     * 超出的部分不再尝试解析，而是抛出明确错误，避免把子请求配额耗尽
     * 后整个请求被边缘节点拒绝（那会表现为难以诊断的 503）。
     */
    const maxDepth = Number(this.addition.max_path_depth) > 0
      ? Number(this.addition.max_path_depth)
      : 32
    if (parts.length > maxDepth) {
      throw new Error(
        `目录层级过深（${parts.length} 层，上限 ${maxDepth}）：139 的接口只支持按父目录 ID 逐层查询，` +
          `无法直接按路径定位。请先逐层浏览一次以建立索引，或调大 max_path_depth 配置。`,
      )
    }

    /**
     * 从**最深的已知前缀**起跳，而不是每层都从根开始。
     *
     * 用户逐层点开时，父层的列表已经把本层 ID 登记好了，因此
     * `lookupPathId` 在 resolveCatalogId 开头就会命中并提前返回。
     * 走到这里说明中途有断档（例如直接跳转到一个没走过的深层路径）。
     * 此时利用索引里任何一段已知前缀，可以把串行解析缩短为
     * "断档点到目标"的那一段。
     */
    const { id: startId, startIndex } = await this.resolveFromDeepestKnown(parts)
    let currentCatalogId = startId
    let currentPath = "/" + parts.slice(0, startIndex).join("/")
    if (currentPath === "/") {
      rememberPathId("/", currentCatalogId, this.indexOpts())
    }

    for (let i = startIndex; i < parts.length; i++) {
      const part = parts[i]

      // 先查索引：列目录时已把下一层子目录登记好，这里通常直接命中，
      // 无需任何网络请求。这是"顺着一层层点下去不卡"的关键。
      const nextPath = joinIndexPath(currentPath, part)
      const known = await lookupPathId(nextPath, this.indexOpts())
      if (known) {
        currentCatalogId = known
        currentPath = nextPath
        continue
      }

      // 索引没有才真正发请求
      const disk = await this.client.listFiles(currentCatalogId)
      const foundFolder = disk.folders.find((f) => f.catalogName === part)

      /**
       * ⚠️ 这里**必须抛错**，绝不能 `break`。
       *
       * 曾经写的是 `if (!foundFolder) break`，然后返回上一层的
       * `currentCatalogId` —— 后果极其隐蔽且严重：
       *
       *   请求 `/移动/移动CAS/cas600t/动漫/B/x.cas`，若索引里
       *   `/移动/移动CAS` 缺失，解析到 `/移动` 就 break，把 **`/移动`
       *   的 catalogID 当作最终结果返回**。上层拿到这个错误 ID 去
       *   `listFiles`，自然找不到 `移动CAS`，于是报出畸形路径
       *   `Item not found: /移动CAS/cas600t/...`（注意 `/移动` 被"吃掉"了），
       *   让人误以为是路径拼接问题而查错方向。
       *
       *   更糟的是 `break` 返回的 ID 指向**上层的大目录**，`listFiles`
       *   会把那一整层的内容全部拉回来（`/移动` 下有大量子目录），
       *   在 Workers 上表现为请求挂死（客户端 120s 超时）或子请求超限（503）。
       *
       * 抛错能让失败**定位到具体是哪一层不存在**，同时避免用错误 ID
       * 继续做昂贵且无意义的调用。
       */
      if (!foundFolder) {
        throw new Error(
          `目录不存在：${nextPath}（在「${currentPath}」下未找到子目录「${part}」，` +
            `已解析层级 ${i + 1}/${parts.length}）`,
        )
      }

      currentCatalogId = foundFolder.catalogID
      currentPath = nextPath

      rememberPathId(currentPath, currentCatalogId, this.indexOpts())

      // 顺手登记本层的**所有**子目录：数据来自同一次响应，零额外成本，
      // 却能省掉后续逐层深入时的整段解析。
      rememberChildren(
        currentPath,
        disk.folders.map((f) => ({ name: f.catalogName, id: f.catalogID })),
        this.indexOpts(),
      )
    }

    return currentCatalogId
  }

  /**
   * 并发受限地执行任务，返回与输入等长的结果数组。
   *
   * 为什么要限流而不是 `Promise.all` 全发：
   * Cloudflare Workers 对**并发出站连接**有硬上限（当前为 6 条），
   * 一次性发出过多请求会被边缘节点拒绝（表现为 503），而不是排队等待。
   * 因此用一个小并发池把连接数压在安全范围内。
   *
   * 为什么不用串行：
   * 在常驻进程（官方 OpenList / 139cas）里，HTTP 连接是 keep-alive 复用的，
   * 逐层解析的实际耗时很短；而 Worker 每次请求都可能新建连接、且往返被
   * 放大，串行会把 N 层的延迟直接相加。用并发把"相加"变成"取最大值"，
   * 这是让深层目录不卡的关键。
   */
  private async runLimited<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
    const results: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(
      items.length,
    )
    let cursor = 0

    const worker = async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        try {
          results[i] = { ok: true, value: await fn(items[i], i) }
        } catch (e) {
          results[i] = {
            ok: false,
            error: e instanceof Error ? e : new Error(String(e)),
          }
        }
      }
    }

    const n = Math.max(1, Math.min(limit, items.length))
    await Promise.all(Array.from({ length: n }, () => worker()))
    return results
  }

  /**
   * 尝试并发解析一批候选路径，返回第一个命中的目录 ID。
   *
   * 用于「索引未命中、需要逐层解析」的场景。传统实现是严格串行的：
   * 必须先知道第 1 层的 ID 才能问第 2 层。但如果索引里已经有一些
   * 中间层的结果，就可以从**最深的已知前缀**开始，减少串行段长度。
   */
  private async resolveFromDeepestKnown(
    parts: string[],
  ): Promise<{ id: string; startIndex: number }> {
    // 从完整路径往前找，定位最深的已知前缀。
    //
    // 注意：不能写成「for 循环里逐个 await lookupPathId」。那样每个前缀
    // 都会各自走一遍「内存未命中 → 读 KV → 整表 JSON.parse」，在深层
    // 路径上直接叠成 N 倍开销 —— 免费版 Worker 只有 10ms CPU 预算，
    // 这正是此前深层目录偶发 503 的元凶之一。
    //
    // 改成先把候选前缀一次性列出来，交给 lookupFirstHit 统一查：
    // KV 只读一次，之后全是内存比对。
    const candidates: string[] = []
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      candidates.push("/" + parts.slice(0, cut).join("/"))
    }
    const best = await lookupFirstHit(candidates, this.indexOpts())
    if (best) {
      const startIndex = best.path.split("/").filter(Boolean).length
      return { id: best.id, startIndex }
    }
    return { id: this.getRootId(), startIndex: 0 }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const clean = this.cleanPath(physicalPath)
    const catalogId = await this.resolveCatalogId(clean)
    const disk = await this.client.listFiles(catalogId)

    // 列目录时把本层路径登记好，并预填下一层子目录的 ID。
    // 这一步是"解析成本不随深度增长"的关键：数据全部来自本次响应，
    // 不产生任何额外请求。
    rememberPathId(clean, catalogId, this.indexOpts())
    rememberChildren(
      clean,
      disk.folders.map((f) => ({ name: f.catalogName, id: f.catalogID })),
      this.indexOpts(),
    )

    const folderItems: FileItem[] = disk.folders.map((f) => ({
      name: f.catalogName,
      size: 0,
      is_dir: true,
      modified: f.updateTime || new Date().toISOString(),
      sign: f.catalogID,
      type: 1,
      raw_url: "",
    }))

    const fileItems: FileItem[] = disk.files.map((f) => {
      const sizeNum =
        typeof f.contentSize === "number"
          ? f.contentSize
          : parseInt(String(f.contentSize || "0"), 10)
      const name = f.contentName || "file"

      // 说明：CAS 占位文件在列表里保持原文件名（xxx.iso.cas）。
      // 不要在列表阶段改名 —— 列表名与文件标识必须一一对应，
      // 否则后续按名字查找会失败。真实文件信息在 /api/fs/get 时呈现。
      return {
        name,
        size: isNaN(sizeNum) ? 0 : sizeNum,
        is_dir: false,
        modified: f.updateTime || f.createTime || new Date().toISOString(),
        sign: f.contentID || name,
        type: calcFileType(name, false),
        thumb: f.thumbnailURL || f.bigThumbnailURL,
        raw_url: "",
      }
    })

    const items = [...folderItems, ...fileItems]
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  /**
   * 取 `.cas` 占位文件的**预览名**（真实视频名），对齐 Go
   * `drivers/139/cas.go:Yun139.CASPreviewName`：
   *
   *   func (d *Yun139) CASPreviewName(ctx context.Context, file model.Obj) (string, error) {
   *     if !isCASName(file.GetName()) { return file.GetName(), nil }
   *     info, err := d.parseCASFromObj(ctx, file)              // ← 只读内容，不还原
   *     if err != nil { return "", err }
   *     previewName, err := resolveCASRestoreName(file.GetName(), info)
   *     if err != nil { return "", err }
   *     if !casmeta.ExtAllowed(previewName, d.CASExtAllowlist) { return file.GetName(), nil }
   *     return previewName, nil
   *   }
   *
   * 该名字只用于计算 `/api/fs/get` 响应的 `type` 字段（`.cas` → 真实视频
   * 扩展名 → VIDEO），**不做秒传还原**，因此只有一次「读文件内容」的子请求，
   * 对播放延迟的影响可忽略。
   *
   * @returns 预览名；非 `.cas` 或解析失败时返回原文件名（与 Go 一致）
   */
  async casPreviewName(casFileId: string, casName: string): Promise<string> {
    if (!isCasName(casName)) return casName
    try {
      const content = await readCasContent(this.client, casFileId)
      const meta = parseCasMeta(content)
      const previewName = deriveCasRealName(casName, meta.name) || casName
      if (
        !casExtAllowed(previewName, this.addition.cas_ext_allowlist || "")
      ) {
        return casName
      }
      return previewName || casName
    } catch {
      // 与 Go 不同：解析失败时不抛错，退回原文件名，避免列表/详情接口 500
      return casName
    }
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").filter(Boolean).pop() || "root"

    if (clean === "/") {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.getRootId(),
        type: 1,
        raw_url: "",
      }
    }

    const parentPath = clean.substring(0, clean.lastIndexOf("/")) || "/"
    const parentCatalogId = await this.resolveCatalogId(parentPath)
    const disk = await this.client.listFiles(parentCatalogId)

    const foundFolder = disk.folders.find((f) => f.catalogName === name)
    if (foundFolder) {
      return {
        name: foundFolder.catalogName,
        size: 0,
        is_dir: true,
        modified: foundFolder.updateTime || new Date().toISOString(),
        sign: foundFolder.catalogID,
        type: 1,
        raw_url: "",
      }
    }

    const foundFile = disk.files.find((f) => f.contentName === name)
    if (foundFile) {
      const sizeNum =
        typeof foundFile.contentSize === "number"
          ? foundFile.contentSize
          : parseInt(String(foundFile.contentSize || "0"), 10)
      const fileName = foundFile.contentName || name

      // ---- CAS 播放支持（列表接口也会取直链，因此这里同样要处理）----
      //
      // OpenList 的 /api/fs/get 会直接使用本方法返回的 raw_url，
      // 而不一定经过 link()。若这里不拦截，.cas 文件会被当成普通文件
      // 返回其自身的直链（只有几百字节的占位内容），导致播放失败。
      let rawUrl = ""
      const casSize = sizeNum
      let casError = ""
      let thumb: string | undefined =
        foundFile.thumbnailURL || foundFile.bigThumbnailURL

      // contentID 在个人新版接口里是 fileId，必然存在；这里显式收窄类型
      const contentId = foundFile.contentID

      // 是否是一个可播放的 `.cas` 占位文件
      const isCasPlayable =
        !!contentId &&
        this.addition.cas_play_enabled !== false &&
        shouldHandleCas(fileName, this.addition.cas_ext_allowlist)

      // 预览名：`第10集.mkv.cas` → `第10集.mkv`。对齐 Go
      // `server/handles/fsread.go:resolveCASPreviewTypeName`，仅用于算 `type`。
      let previewName = fileName
      if (isCasPlayable) {
        previewName = await this.casPreviewName(contentId!, fileName)
      }

      if (isCasPlayable) {
        try {
          const link = await resolveCasPlayLink({
            client: this.client,
            rootId: this.getRootId(),
            casFileId: contentId!,
            casName: fileName,
            autoCleanup: this.addition.cas_auto_cleanup !== false,
            // 复用已知的临时目录 ID，省掉一次"列根目录找 TEMP"的往返。
            // 播放是延迟敏感路径，Workers 的子请求/CPU 有硬限制，
            // 每省一次往返都能明显降低超限（503）风险。
            tempDirId: this.tempDirId,
          })
          if (link.tempDirId) this.tempDirId = link.tempDirId
          rawUrl = link.url
          // ⚠️ 刻意**不**采用还原后文件的真实大小。
          // 对齐 Go：FsGet 返回的 `size` 来自 `fs.Get` 拿到的原始对象，
          // 即 `.cas` 占位文件本身的大小（540 字节），而不是真实视频大小。
          // 网易爆米花等播放器按 `.strm` → `.cas` 链路工作，行为需一致。
          thumb = undefined
        } catch (e) {
          casError = e instanceof Error ? e.message : String(e)
          console.error(`[139] CAS 播放失败 ${clean}:`, e)
          // ⚠️ **不要**回退到 `.cas` 自身的直链。
          //
          // 那个直链指向的是 540 字节的占位文件（内容是 base64 的 CAS JSON），
          // 播放器拿到它只会得到一坨无法解码的数据，表现为「无法播放」，
          // 且完全看不出真实原因（可能是云端配额不足、内容已删除等）。
          //
          // Go 版在此处直接返回错误（`failed link: ...`），由上层转成 HTTP 500
          // 并把原因写在响应体里。CF 版保持同样语义：把 `raw_url` 留空，
          // 由 `raw_url_error` 承载具体原因，前端/调用方能拿到准确报错。
          rawUrl = ""
        }
      } else if (contentId) {
        try {
          rawUrl = await this.client.getDownloadUrl(contentId)
        } catch (e) {
          console.warn("[139] failed to get download url in get():", e)
        }
      }

      return {
        name: fileName,
        size: isNaN(casSize) ? 0 : casSize,
        is_dir: false,
        modified:
          foundFile.updateTime ||
          foundFile.createTime ||
          new Date().toISOString(),
        sign: foundFile.contentID || name,
        // `type` 用**预览名**推算（对齐 Go `utils.GetFileType(typeName)`），
        // 于是 `.cas` 会得到真实视频的类型（如 mkv → VIDEO=2），
        // 而不是 `.cas` 自身的 UNKNOWN=0。
        type: calcFileType(previewName, false),
        thumb,
        raw_url: rawUrl,
        raw_url_error: casError || undefined,
        cas_preview_name: previewName !== fileName ? previewName : undefined,
      }
    }

    throw new Error(`Item not found: ${clean}`)
  }

  async link(
    virtualPath: string,
    physicalPath: string,
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    const item = await this.get(virtualPath, physicalPath)
    if (item.is_dir) {
      throw new Error(`Cannot get link for folder: ${physicalPath}`)
    }

    // ---- CAS 播放支持 ----
    // 若当前文件是 .cas 占位文件，则走"秒传恢复 + 取直链"的播放流程。
    // 详见 ./cas/ 目录。可通过驱动配置 cas_play_enabled=false 关闭。
    if (
      this.addition.cas_play_enabled !== false &&
      shouldHandleCas(item.name, this.addition.cas_ext_allowlist)
    ) {
      try {
        const link = await resolveCasPlayLink({
          client: this.client,
          rootId: this.getRootId(),
          casFileId: item.sign,
          casName: item.name,
          autoCleanup: this.addition.cas_auto_cleanup !== false,
          // 复用已知的临时目录 ID，减少一次往返（见 get() 中的说明）
          tempDirId: this.tempDirId,
        })
        if (link.tempDirId) this.tempDirId = link.tempDirId
        return {
          url: link.url,
          headers: link.headers,
        }
      } catch (e) {
        console.error(`[139] CAS 播放失败 ${physicalPath}:`, e)
        throw e
      }
    }

    const url = await this.client.getDownloadUrl(item.sign)
    return {
      url,
      headers: {
        Referer: "https://yun.139.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.substring(0, clean.lastIndexOf("/")) || "/"
    const dirName = clean.substring(clean.lastIndexOf("/") + 1)
    const parentCatalogId = await this.resolveCatalogId(parentPath)

    await this.client.createCatalog(parentCatalogId, dirName)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const item = await this.get(virtualPath, physicalPath)
    await this.client.rename(item.sign, newName)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const catalogId = await this.resolveCatalogId(clean)
    const disk = await this.client.listFiles(catalogId)

    for (const name of names) {
      const folder = disk.folders.find((f) => f.catalogName === name)
      if (folder) {
        await this.client.deleteCatalog(folder.catalogID)
      } else {
        const file = disk.files.find((f) => f.contentName === name)
        if (file && file.contentID) {
          await this.client.deleteFile(file.contentID)
        }
      }
    }
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    console.warn(`[139] move from ${srcPhys} to ${dstPhys}`)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    console.warn(`[139] copy from ${srcPhys} to ${dstPhys}`)
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer | Uint8Array,
  ): Promise<void> {
    console.warn(`[139] put for ${physicalPath}`)
  }

  async getDetails(): Promise<{ total_space?: number; used_space?: number }> {
    try {
      const details = await this.client.getStorageDetails()
      return {
        total_space: details.total,
        used_space: details.used,
      }
    } catch {
      return {}
    }
  }
}
