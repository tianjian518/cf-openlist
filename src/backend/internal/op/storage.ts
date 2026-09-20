import { resolvePath, getDb, saveDb, getEnvCtx } from "../model/db"
import { FileItem, StorageDriver, calcFileType } from "../driver/base"
import { Onedrive } from "../../drivers/onedrive/driver"
import { OnedriveAPP } from "../../drivers/onedrive_app/driver"
import { AliyundriveOpen } from "../../drivers/aliyundrive_open/driver"
import { GoogleDrive } from "../../drivers/google_drive/driver"
import { QuarkDriver } from "../../drivers/quark/driver"
import { Driver115 } from "../../drivers/115/driver"
import { DriverCloudreve } from "../../drivers/cloudreve_v4/driver"
import { DriverCloudreveV3 } from "../../drivers/cloudreve_v3/driver"
import { DriverOpenlist } from "../../drivers/openlist/driver"
import { DriverOpenlistShare } from "../../drivers/openlist_share/driver"
import { DriverTeldrive } from "../../drivers/teldrive/driver"
import { DriverMediafire } from "../../drivers/mediafire/driver"
import { DriverGithubReleases } from "../../drivers/github_releases/driver"
import { DriverCnbReleases } from "../../drivers/cnb_releases/driver"
import { DriverKodbox } from "../../drivers/kodbox/driver"
import { DriverIpfs } from "../../drivers/ipfs_api/driver"
import { DriverLenovoNasShare } from "../../drivers/lenovonas_share/driver"
import { DriverMisskey } from "../../drivers/misskey/driver"
import { DriverDoubao } from "../../drivers/doubao/driver"
import { DriverDoubaoNew } from "../../drivers/doubao_new/driver"
import { DriverQuarkOpen } from "../../drivers/quark_open/driver"
import { DriverQuarkUcTv } from "../../drivers/quark_uc_tv/driver"
import { Driver123Open } from "../../drivers/123_open/driver"
import { DriverTeambition } from "../../drivers/teambition/driver"
import { DriverChaoXing } from "../../drivers/chaoxing/driver"
import { DriverGooglePhoto } from "../../drivers/google_photo/driver"
import { DriverFebBox } from "../../drivers/febbox/driver"
import { DriverDegoo } from "../../drivers/degoo/driver"
import { DriverNeteaseMusic } from "../../drivers/netease_music/driver"
import { DriverHalalCloudOpen } from "../../drivers/halalcloud_open/driver"
import { Pan123Driver } from "../../drivers/123pan/driver"
import {
  BaiduDriver,
  normalizeBaiduAddition,
} from "../../drivers/baidu_netdisk/driver"
import { DriverBaiduPhoto } from "../../drivers/baidu_photo/driver"
import { Pan115Driver } from "../../drivers/115open/driver"
import { GithubDriver } from "../../drivers/github/driver"
import {
  ThunderDriver,
  ThunderExpertDriver,
} from "../../drivers/thunder/driver"
import { LanzouDriver } from "../../drivers/lanzou/driver"
import { Cloud189Driver } from "../../drivers/189/driver"
import { Driver189TV } from "../../drivers/189_tv/driver"
import { WebdavDriver } from "../../drivers/webdav/driver"
import { WoPanDriver, normalizeWoPanAddition } from "../../drivers/wopan/driver"
import { MoPanDriver } from "../../drivers/mopan/driver"
import { S3Driver, normalizeS3Addition } from "../../drivers/s3/driver"
import {
  WeiyunDriver,
  normalizeWeiyunAddition,
} from "../../drivers/weiyun/driver"
import { PikPakDriver } from "../../drivers/pikpak/driver"
import { SeafileDriver } from "../../drivers/seafile/driver"
import { YandexDriver } from "../../drivers/yandex/driver"
import { TeraboxDriver } from "../../drivers/terabox/driver"
import { MediatrackDriver } from "../../drivers/mediatrack/driver"
import { AliasDriver } from "../../drivers/alias/driver"
import { DropboxDriver } from "../../drivers/dropbox/driver"
import { WpsDriver } from "../../drivers/wps/driver"
import { Yun139Driver } from "../../drivers/139/driver"
import { resetPathIndexRequestBudget } from "../../drivers/139/pathindex"
import { flushCache as flushLinkCacheStore } from "../../drivers/139/linkcache"
import { MegaDriver } from "../../drivers/mega/driver"
import { Pan115ShareDriver } from "../../drivers/115_share/driver"
import { Pan123ShareDriver } from "../../drivers/123_share/driver"
import { AliyundriveShareDriver } from "../../drivers/aliyundrive_share/driver"
import { OnedriveSharelinkDriver } from "../../drivers/onedrive_sharelink/driver"
import { PikPakShareDriver } from "../../drivers/pikpak_share/driver"
import { SMBDriver } from "../../drivers/smb/driver"
import { CryptDriver } from "../../drivers/crypt/driver"
import { VirtualDriver } from "../../drivers/virtual/driver"
import { AListV3Driver } from "../../drivers/alist_v3/driver"
import { UrlTreeDriver } from "../../drivers/url_tree/driver"
import { StrmDriver } from "../../drivers/strm/driver"
import { ChunkDriver } from "../../drivers/chunk/driver"
import { AzureBlobDriver } from "../../drivers/azure_blob/driver"
import { UssDriver } from "../../drivers/uss/driver"
import { AliDocDriver } from "../../drivers/alidoc/driver"
import { EmbyDriver } from "../../drivers/emby/driver"
import { BunnyStorageDriver } from "../../drivers/bunny_storage/driver"
import { CFImgBedDriver } from "../../drivers/cloudflare_imgbed/driver"
import { GuangYaPanDriver } from "../../drivers/guangyapan/driver"
import { AutoIndexDriver } from "../../drivers/autoindex/driver"
import { ProtonDriveDriver } from "../../drivers/proton_drive/driver"
import { goEncodePath } from "../../pkg/urlpath"

// LocalDriver is not available in Cloudflare Workers (no fs module).
// When running in Node.js container mode, import dynamically on first use.
let _localDriver: StorageDriver | null = null
async function getLocalDriver(): Promise<StorageDriver> {
  if (!_localDriver) {
    const { LocalDriver } = await import("../../drivers/local")
    _localDriver = new LocalDriver()
  }
  return _localDriver
}

async function getSFTPDriver(storageConfig: any): Promise<StorageDriver> {
  if (typeof process !== "undefined" && process.release?.name === "node") {
    const { SFTPDriver } = await import("../../drivers/sftp")
    const driver = new SFTPDriver(parseAddition(storageConfig))
    await driver.init?.()
    return driver
  }
  throw new Error(
    "SFTP storage driver requires Node.js runtime (raw TCP sockets not available in Cloudflare Workers)",
  )
}

async function getFTPDriver(storageConfig: any): Promise<StorageDriver> {
  if (typeof process !== "undefined" && process.release?.name === "node") {
    const { FTPDriver } = await import("../../drivers/ftp")
    const driver = new FTPDriver(parseAddition(storageConfig))
    await driver.init?.()
    return driver
  }
  throw new Error(
    "FTP storage driver requires Node.js runtime (raw TCP sockets not available in Cloudflare Workers)",
  )
}

const driverCache = new Map<string, StorageDriver>()
const driverInitCache = new Map<string, Promise<StorageDriver>>()
const cookiePersistenceCache = new Map<string, Promise<void>>()

// M-8：驱动实例缓存容量上限。storage.modified 变化会产生新 key，旧条目若不清理，
// 长生命周期 isolate 中会无限累积。超出上限时按插入顺序淘汰最旧条目。
const MAX_DRIVER_CACHE = 100

function setDriverCache(key: string, driver: StorageDriver): void {
  if (driverCache.size >= MAX_DRIVER_CACHE) {
    const oldestKey = driverCache.keys().next().value
    if (oldestKey !== undefined) driverCache.delete(oldestKey)
  }
  driverCache.set(key, driver)
}

export interface StorageRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void
  env?: any // ESA/Cloudflare env，用于请求级缓存复用
  /**
   * 当次请求的站点 origin（如 `https://tj518.de5.net`）。
   *
   * 对齐 Go：Go 侧 `common.GetApiUrl(ctx)` 从 context 里读请求级站点地址，
   * 驱动（尤其 strm）在生成直链时会用到。TS 版没有 ctx，改用显式字段，
   * 由 server 层构造 requestContext 时填好，op 层再透传给 getDriver。
   */
  requestOrigin?: string
}

export async function getOrCreateDriver(
  cache: Map<string, Promise<StorageDriver>>,
  key: string,
  factory: () => Promise<StorageDriver>,
): Promise<StorageDriver> {
  const existing = cache.get(key)
  if (existing) return existing

  const pending = factory()
  cache.set(key, pending)
  try {
    return await pending
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key)
    throw error
  }
}

function parseAddition(storageConfig?: any): any {
  const additionStr = storageConfig?.addition
  if (!additionStr) return {}
  return typeof additionStr === "string"
    ? JSON.parse(additionStr || "{}")
    : additionStr
}

/**
 * 解析 strm 驱动使用的站点绝对地址（协议 + 主机，无尾斜杠）。
 *
 * 对齐 Go `common.GetApiUrl(ctx)`：Go 版在 strm 存储未配 `siteUrl` 时，
 * 会回退到「当前请求的站点地址」，从而让 .strm 文件里写出**完整 URL**。
 *
 * 优先级：
 *   1. 显式传入的 requestOrigin（当次请求的 origin，最准确）
 *   2. 全局站点配置 `seed_site_url`（管理员可固化公开域名）
 *   3. env 里的 `__requestOrigin`（中间件注入的最后一次请求 origin）
 *
 * 为什么必须补全：`.strm` 是独立文件，播放器/媒体库（网易爆米花、
 * Emby、Kodi、Infuse 等）把文件内容当成一个**独立 URL** 去请求，
 * 没有站点上下文可供推断相对路径 → 相对路径必然播放失败。
 */
async function resolveStrmSiteUrl(requestOrigin?: string): Promise<string> {
  const normalize = (u: any): string =>
    String(u || "")
      .trim()
      .replace(/\/+$/, "")

  const direct = normalize(requestOrigin)
  if (direct) return direct

  try {
    const { getSettings } = await import("../model/db")
    const settings = await getSettings()
    const configured = normalize(settings?.["seed_site_url"])
    if (configured) return configured
  } catch {
    // 忽略：继续走 env 回退
  }

  try {
    const env = getEnvCtx?.()
    const fromEnv = normalize(env?.__requestOrigin)
    if (fromEnv) return fromEnv
  } catch {
    // 忽略
  }

  return ""
}

async function createDriver(
  driverName: string,
  storageConfig?: any,
  requestOrigin?: string,
): Promise<StorageDriver> {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  if (normDriver === "local") {
    // Only available in Node.js container — not in Cloudflare Workers
    if (typeof process !== "undefined" && process.release?.name === "node") {
      return getLocalDriver()
    }
    throw new Error(
      "Local storage driver requires Node.js runtime (not available in Cloudflare Workers)",
    )
  }
  if (normDriver === "sftp") {
    return getSFTPDriver(storageConfig)
  }
  if (normDriver === "ftp") {
    return getFTPDriver(storageConfig)
  }

  if (!storageConfig) {
    throw new Error(
      "failed get driver: storage config not found for driver " + driverName,
    )
  }

  let driver: StorageDriver
  if (normDriver === "onedriveapp") {
    driver = new OnedriveAPP(parseAddition(storageConfig))
    try {
      await driver.init?.()
    } catch (e) {
      console.error("onedrive_app init failed:", e)
      throw e
    }
  } else if (
    normDriver === "onedrive" ||
    normDriver === "onedrivesb" ||
    normDriver === "onedrivebusiness" ||
    normDriver === "onedrivesharepoint" ||
    (normDriver.startsWith("onedrive") && normDriver !== "onedriveapp")
  ) {
    driver = new Onedrive(
      parseAddition(storageConfig),
      async (refreshToken) => {
        try {
          const db = await getDb()
          const st = (db.storages || []).find(
            (s: any) => s.id === storageConfig?.id,
          )
          if (!st) return
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          stAddition.refresh_token = refreshToken
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        } catch (e) {
          console.warn("[Onedrive] failed to persist refresh token:", e)
        }
      },
    )
    try {
      await driver.init?.()
    } catch (e) {
      console.error("onedrive init failed:", e)
      throw e
    }
  } else if (
    normDriver === "aliyundrive" ||
    normDriver === "aliyundriveopen" ||
    normDriver === "aliyundriveshare" ||
    normDriver === "aliyun" ||
    normDriver === "aliyundriveshare2open" ||
    normDriver === "aliyundriveoauth2" ||
    normDriver.includes("aliyun")
  ) {
    // 统一只保留阿里云盘 OAuth2 (AliyundriveOpen)
    driver = new AliyundriveOpen(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "googlephoto" ||
    normDriver === "googlephotos" ||
    normDriver === "gphoto" ||
    normDriver === "google_photo"
  ) {
    driver = new DriverGooglePhoto(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "googledrive" ||
    normDriver === "gdrive" ||
    normDriver === "google" ||
    normDriver.startsWith("google")
  ) {
    driver = new GoogleDrive(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "quark" ||
    normDriver === "quarkuc" ||
    normDriver === "uc" ||
    normDriver === "quarkcookie"
  ) {
    driver = new QuarkDriver(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "115" ||
    normDriver === "115cloud" ||
    normDriver === "115open" ||
    normDriver === "115netdisk"
  ) {
    driver = new Driver115(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "cloudreve" ||
    normDriver === "cloudrevev3" ||
    normDriver === "cloudreve_v3"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new DriverCloudreveV3(addition, async (cookie: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.cookie = cookie
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[cloudreve] failed to persist cookie:", e)
      }
    })
    await driver.init?.()
  } else if (normDriver === "cloudrevev4" || normDriver === "cloudreve_v4") {
    driver = new DriverCloudreve(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "openlistshare" ||
    normDriver === "openlist_share"
  ) {
    driver = new DriverOpenlistShare(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "openlist") {
    driver = new DriverOpenlist(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "teldrive") {
    driver = new DriverTeldrive(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "mediafire") {
    driver = new DriverMediafire(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "githubreleases" ||
    normDriver === "github_releases"
  ) {
    driver = new DriverGithubReleases(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "cnbreleases" || normDriver === "cnb_releases") {
    driver = new DriverCnbReleases(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "kodbox" || normDriver === "kodo") {
    driver = new DriverKodbox(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "ipfs" ||
    normDriver === "ipfsapi" ||
    normDriver === "ipfs_api"
  ) {
    driver = new DriverIpfs(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "lenovonasshare" ||
    normDriver === "lenovonas_share"
  ) {
    driver = new DriverLenovoNasShare(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "misskey") {
    driver = new DriverMisskey(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    // 新版豆包（飞书云空间 + DPoP 认证），配置字段与旧版不兼容，必须优先匹配
    normDriver === "doubaonew" ||
    normDriver === "doubao_new" ||
    normDriver === "doubaonewdev"
  ) {
    driver = new DriverDoubaoNew(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    // 旧版豆包：接口已下线，保留仅为兼容历史配置
    normDriver === "doubao" ||
    normDriver === "doubaoshare" ||
    normDriver === "doubao_share"
  ) {
    driver = new DriverDoubao(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "quarkopen" ||
    normDriver === "quark_open" ||
    normDriver === "quarkoa"
  ) {
    driver = new DriverQuarkOpen(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "quarktv" ||
    normDriver === "uctv" ||
    normDriver === "quark_uc_tv"
  ) {
    driver = new DriverQuarkUcTv(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "123open" ||
    normDriver === "123_open" ||
    normDriver === "123cloudopen"
  ) {
    driver = new Driver123Open(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "teambition" || normDriver === "tb") {
    driver = new DriverTeambition(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "neteasemusic" ||
    normDriver === "netease" ||
    normDriver === "neteasecloudmusic" ||
    normDriver === "netease_music"
  ) {
    driver = new DriverNeteaseMusic(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "halalcloudopen" ||
    normDriver === "halalcloud_open" ||
    normDriver === "halalcloudopenapi"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new DriverHalalCloudOpen(
      addition,
      async (refreshToken: string) => {
        try {
          const db = await getDb()
          const st = (db.storages || []).find(
            (s: any) => s.id === storageConfig?.id,
          )
          if (!st) return
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          stAddition.refresh_token = refreshToken
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        } catch (e) {
          console.warn("[HalalCloud] failed to persist refresh_token:", e)
        }
      },
    )
    await driver.init?.()
  } else if (normDriver === "degoo") {
    const addition = parseAddition(storageConfig)
    driver = new DriverDegoo(
      addition,
      async (tokens: { accessToken?: string; refreshToken?: string }) => {
        try {
          const db = await getDb()
          const st = (db.storages || []).find(
            (s: any) => s.id === storageConfig?.id,
          )
          if (!st) return
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          if (tokens.accessToken) stAddition.access_token = tokens.accessToken
          if (tokens.refreshToken)
            stAddition.refresh_token = tokens.refreshToken
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        } catch (e) {
          console.warn("[degoo] failed to persist tokens:", e)
        }
      },
    )
    await driver.init?.()
  } else if (normDriver === "febbox" || normDriver === "febboxpan") {
    const addition = parseAddition(storageConfig)
    driver = new DriverFebBox(addition, async (refreshToken: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.refresh_token = refreshToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[febbox] failed to persist refresh_token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "chaoxing" ||
    normDriver === "chaoxinggroupdrive" ||
    normDriver === "chaoxinggroup" ||
    normDriver.startsWith("chaoxing")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new DriverChaoXing(addition, async (cookie: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.cookie = cookie
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[chaoxing] failed to persist cookie:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "123pan" ||
    normDriver === "123" ||
    normDriver === "123panshare" ||
    normDriver.startsWith("123")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan123Driver(addition, async (token: string) => {
      // Persist the refreshed 123Pan access_token back to the storage config
      // so subsequent cold starts skip password login (avoiding overseas-IP
      // risk control in Cloudflare Workers).
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[123Pan] failed to persist access_token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "baiduphoto" ||
    normDriver === "baidu_photo" ||
    normDriver === "baiduphotos"
  ) {
    driver = new DriverBaiduPhoto(parseAddition(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "baidunetdisk" ||
    normDriver === "baidu" ||
    normDriver === "baiduyun" ||
    normDriver === "baidushare" ||
    normDriver.startsWith("baidu")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new BaiduDriver(addition, async (tokens) => {
      // Persist refreshed tokens (and normalized defaults) back to the
      // storage config so cold starts skip OAuth entirely.
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = tokens.access_token
        stAddition.refresh_token = tokens.refresh_token
        st.addition = JSON.stringify(normalizeBaiduAddition(stAddition))
        await saveDb(db)
      } catch (e) {
        console.warn("[baidu_netdisk] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "115open" ||
    normDriver === "115" ||
    normDriver === "115pan" ||
    normDriver === "115cloud" ||
    normDriver.startsWith("115")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan115Driver(addition, async (tokens) => {
      // 持久化刷新后的 access_token / refresh_token，避免冷启动重复刷新
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = tokens.access_token
        stAddition.refresh_token = tokens.refresh_token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[115open] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "github" ||
    normDriver === "githubapi" ||
    normDriver === "github_api"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new GithubDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "thunderexpert" ||
    normDriver === "thunderbrowserexpert" ||
    normDriver === "thunderxexpert" ||
    (normDriver.includes("thunder") && normDriver.includes("expert")) ||
    (normDriver.includes("xunlei") && normDriver.includes("expert"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new ThunderExpertDriver(addition, async (tokens) => {
      try {
        if (tokens.device_id) addition.device_id = tokens.device_id
        if (tokens.refresh_token) addition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token) addition.captcha_token = tokens.captcha_token
        storageConfig.addition = JSON.stringify(addition)

        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (st) {
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          if (tokens.refresh_token)
            stAddition.refresh_token = tokens.refresh_token
          if (tokens.captcha_token)
            stAddition.captcha_token = tokens.captcha_token
          if (tokens.device_id) stAddition.device_id = tokens.device_id
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        }
      } catch (e) {
        console.warn("[thunderexpert] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "thunder" ||
    normDriver === "xunlei" ||
    normDriver === "thunderbrowser" ||
    normDriver === "thunderx" ||
    normDriver.includes("thunder") ||
    normDriver.includes("xunlei")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new ThunderDriver(addition, async (tokens) => {
      try {
        if (tokens.device_id) addition.device_id = tokens.device_id
        if (tokens.refresh_token) addition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token) addition.captcha_token = tokens.captcha_token
        storageConfig.addition = JSON.stringify(addition)

        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (st) {
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          if (tokens.refresh_token)
            stAddition.refresh_token = tokens.refresh_token
          if (tokens.captcha_token)
            stAddition.captcha_token = tokens.captcha_token
          if (tokens.device_id) stAddition.device_id = tokens.device_id
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        }
      } catch (e) {
        console.warn("[thunder] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "lanzou" ||
    normDriver === "lanzoupan" ||
    normDriver === "ilanzou" ||
    normDriver === "lanzoui" ||
    normDriver === "lanzous"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new LanzouDriver(addition, async (cookie) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.cookie = cookie
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[Lanzou] failed to persist cookie:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "189tv" ||
    normDriver === "cloud189tv" ||
    normDriver === "189tvcloud" ||
    normDriver === "189_tv"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Driver189TV(addition, async (accessToken: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = accessToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[189TV] failed to persist access_token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "189" ||
    normDriver === "189cloud" ||
    normDriver === "cloud189" ||
    normDriver === "ctyun" ||
    normDriver === "189pan" ||
    normDriver === "189cloudpc" ||
    normDriver === "189cloudapp" ||
    normDriver.startsWith("189") ||
    normDriver.includes("cloud189")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Cloud189Driver(addition)
    await driver.init?.()
  } else if (normDriver === "webdav" || normDriver === "webdavdriver") {
    const addition = parseAddition(storageConfig)
    driver = new WebdavDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "s3" ||
    normDriver === "doge" ||
    normDriver === "dogecloud" ||
    normDriver === "minio" ||
    normDriver === "ceph" ||
    normDriver === "aws" ||
    normDriver === "r2" ||
    normDriver === "b2" ||
    normDriver === "cos" ||
    normDriver === "oss" ||
    normDriver === "kodo"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new S3Driver(addition, storageConfig.driver || "S3")
    await driver.init?.()
  } else if (
    normDriver === "wopan" ||
    normDriver === "unicom" ||
    normDriver === "unicomcloud" ||
    normDriver === "woyun" ||
    normDriver === "chinaunicom"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new WoPanDriver(addition, async (accessToken, refreshToken) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = accessToken
        stAddition.refresh_token = refreshToken
        st.addition = JSON.stringify(normalizeWoPanAddition(stAddition))
        await saveDb(db)
      } catch (e) {
        console.warn("[WoPan] failed to persist tokens:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "weiyun" ||
    normDriver === "tencentweiyun" ||
    normDriver === "txweiyun" ||
    normDriver.includes("weiyun")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new WeiyunDriver(addition, async (cookie) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.cookies = cookie
        st.addition = JSON.stringify(normalizeWeiyunAddition(stAddition))
        await saveDb(db)
      } catch (e) {
        console.warn("[WeiYun] failed to persist cookies:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "pikpak" ||
    normDriver === "pikpakshare" ||
    normDriver.includes("pikpak")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new PikPakDriver(addition, async (tokens) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.refresh_token = tokens.refreshToken
        if (tokens.captchaToken) {
          stAddition.captcha_token = tokens.captchaToken
        }
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[PikPak] failed to persist tokens:", e)
      }
    })
    await driver.init?.()
  } else if (normDriver === "seafile" || normDriver.includes("seafile")) {
    const addition = parseAddition(storageConfig)
    driver = new SeafileDriver(addition, async (token) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.token = token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[Seafile] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "yandex" ||
    normDriver === "yandexdisk" ||
    normDriver === "yandexdrive" ||
    normDriver.includes("yandex")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new YandexDriver(addition, async (tokens) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.refresh_token = tokens.refreshToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[Yandex] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "terabox" ||
    normDriver === "dubox" ||
    normDriver.includes("terabox")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new TeraboxDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "mediatrack" ||
    normDriver === "fenmiao" ||
    normDriver.includes("mediatrack")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new MediatrackDriver(addition)
    await driver.init?.()
  } else if (normDriver === "alias" || normDriver.includes("alias")) {
    const addition = parseAddition(storageConfig)
    driver = new AliasDriver(addition)
    await driver.init?.()
  } else if (normDriver === "dropbox" || normDriver.includes("dropbox")) {
    const addition = parseAddition(storageConfig)
    driver = new DropboxDriver(addition, async (tokens) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = tokens.accessToken
        stAddition.refresh_token = tokens.refreshToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[Dropbox] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "wps" ||
    normDriver.includes("wps") ||
    normDriver.includes("kdocs")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new WpsDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "mopan" ||
    normDriver === "mobilecloud" ||
    normDriver === "cmcc" ||
    normDriver === "chinamobile" ||
    normDriver.includes("mopan")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new MoPanDriver(addition, async (deviceInfo, token) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.device_info = deviceInfo
        // Extract Bearer token if present
        const cleanToken = token.replace(/^Bearer\s+/i, "")
        stAddition.token = cleanToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[MoPan] failed to persist tokens:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "139" ||
    normDriver === "139yun" ||
    normDriver === "caiyun" ||
    normDriver === "hecaiyun" ||
    normDriver.includes("139")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Yun139Driver(addition)
    await driver.init?.()
  } else if (
    normDriver === "mega" ||
    normDriver === "meganz" ||
    normDriver.includes("mega")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new MegaDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "115share" ||
    normDriver === "115sharelink" ||
    (normDriver.includes("115") && normDriver.includes("share"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan115ShareDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "123share" ||
    normDriver === "123panshare" ||
    normDriver === "123link" ||
    (normDriver.includes("123") && normDriver.includes("share"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan123ShareDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "aliyundriveshare" ||
    normDriver === "aliyunshare" ||
    normDriver === "alishare" ||
    (normDriver.includes("ali") && normDriver.includes("share"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new AliyundriveShareDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "onedrivesharelink" ||
    normDriver === "onedriveshare" ||
    normDriver === "sharepointshare" ||
    (normDriver.includes("onedrive") && normDriver.includes("share"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new OnedriveSharelinkDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "pikpakshare" ||
    (normDriver.includes("pikpak") && normDriver.includes("share"))
  ) {
    const addition = parseAddition(storageConfig)
    driver = new PikPakShareDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "smb" ||
    normDriver === "samba" ||
    normDriver === "cifs" ||
    normDriver.includes("smb")
  ) {
    const addition = parseAddition(storageConfig)
    driver = new SMBDriver(addition)
    await driver.init?.()
  } else if (normDriver === "crypt") {
    const addition = parseAddition(storageConfig)
    driver = new CryptDriver(addition)
    await driver.init?.()
  } else if (normDriver === "virtual") {
    const addition = parseAddition(storageConfig)
    driver = new VirtualDriver(addition)
  } else if (
    normDriver === "alistv3" ||
    normDriver === "alist" ||
    normDriver === "alistv2"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new AListV3Driver(addition, async (token: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.token = token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[alist_v3] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (normDriver === "urltree" || normDriver === "urlstree") {
    const addition = parseAddition(storageConfig)
    driver = new UrlTreeDriver(addition, async (urlStructure: string) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.url_structure = urlStructure
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[url_tree] failed to persist structure:", e)
      }
    })
    await driver.init?.()
  } else if (normDriver === "strm") {
    const addition = parseAddition(storageConfig)
    const strmDriver = new StrmDriver(addition)
    // 注入签名上下文：strm 在 withSign 开启时需对路径签名。
    // 对齐 Go internal/sign：secret = setting.GetStr(conf.Token)，
    // expire 单位小时（0 = 永不过期）。此处尽力获取，取不到则用空串（不签名）。
    try {
      const { getJwtSecret } = await import("../../server/middlewares")
      const env = getEnvCtx?.()
      const secret = await getJwtSecret({ env })
      let linkExpirationHours = 0
      try {
        const db = await getDb()
        for (const s of (db as any).settings || []) {
          if (s.key === "link_expiration") {
            linkExpirationHours = parseInt(s.value, 10) || 0
            break
          }
        }
      } catch {}
      strmDriver.setSignContext(secret, linkExpirationHours)
      // 站点绝对地址：.strm 文件内容必须是完整 URL，否则播放器无从解析。
      // 对齐 Go strm 驱动 `getLink` 中 siteUrl 留空时走 common.GetApiUrl(ctx)。
      const siteUrl = await resolveStrmSiteUrl(requestOrigin)
      if (siteUrl) strmDriver.setSiteBaseUrl(siteUrl)
    } catch (e) {
      console.warn("[strm] failed to load sign context:", e)
    }
    driver = strmDriver
    await driver.init?.()
  } else if (normDriver === "chunk") {
    const addition = parseAddition(storageConfig)
    driver = new ChunkDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "azureblob" ||
    normDriver === "azure" ||
    normDriver === "azblob"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new AzureBlobDriver(addition)
    await driver.init?.()
  } else if (normDriver === "uss" || normDriver === "upyun") {
    const addition = parseAddition(storageConfig)
    driver = new UssDriver(addition)
    await driver.init?.()
  } else if (normDriver === "autoindex" || normDriver === "nginxautoindex") {
    const addition = parseAddition(storageConfig)
    driver = new AutoIndexDriver(addition)
    await driver.init?.()
  } else if (normDriver === "protondrive" || normDriver === "proton") {
    const addition = parseAddition(storageConfig)
    driver = new ProtonDriveDriver(addition)
    await driver.init?.()
  } else if (normDriver === "alidoc" || normDriver === "dingtalkdoc") {
    const addition = parseAddition(storageConfig)
    driver = new AliDocDriver(addition)
    await driver.init?.()
  } else if (normDriver === "emby" || normDriver === "jellyfin") {
    const addition = parseAddition(storageConfig)
    driver = new EmbyDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "bunnystorage" ||
    normDriver === "bunnycdn" ||
    normDriver === "bunny"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new BunnyStorageDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "cloudflareimgbed" ||
    normDriver === "cfimgbed" ||
    normDriver === "cloudflareimage"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new CFImgBedDriver(addition)
    await driver.init?.()
  } else if (normDriver === "guangyapan" || normDriver === "guangya") {
    const addition = parseAddition(storageConfig)
    driver = new GuangYaPanDriver(addition, async (accessToken, refreshToken) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = accessToken
        if (refreshToken) stAddition.refresh_token = refreshToken
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[GuangYaPan] failed to persist tokens:", e)
      }
    })
    await driver.init?.()
  } else {
    throw new Error(
      "failed get driver: unsupported driver '" + driverName + "'",
    )
  }

  return driver
}

export async function getDriver(
  driverName: string,
  storageConfig?: any,
  requestOrigin?: string,
): Promise<StorageDriver> {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  if (normDriver === "local") {
    return createDriver(driverName, storageConfig, requestOrigin)
  }

  if (!storageConfig) {
    throw new Error(
      "failed get driver: storage config not found for driver " + driverName,
    )
  }

  const cacheKey = `${storageConfig.id}_${storageConfig.modified}`
  const cached = driverCache.get(cacheKey)
  if (cached) {
    // 缓存命中也要刷新运行时上下文。
    //
    // 驱动实例是跨请求长期复用的（key 为 id_modified），但 env 与
    // storageId 属于「当次请求/部署」的上下文。若只在创建时注入一次，
    // 则后续请求拿到的可能是首次创建时的旧值（甚至 undefined），
    // 依赖它工作的功能（如 139 的路径索引需要落 KV）会静默失效。
    injectRuntimeContext(cached, storageConfig, driverName, requestOrigin)
    return cached
  }

  return getOrCreateDriver(driverInitCache, cacheKey, async () => {
    const ready = driverCache.get(cacheKey)
    if (ready) {
      injectRuntimeContext(ready, storageConfig, driverName, requestOrigin)
      return ready
    }
    const driver = await createDriver(driverName, storageConfig, requestOrigin)
    injectRuntimeContext(driver, storageConfig, driverName, requestOrigin)
    setDriverCache(cacheKey, driver)
    return driver
  })
}

/**
 * 向驱动注入运行时上下文（存储 id + 环境绑定）。
 *
 * 需要它的驱动通过可选方法 `setRuntimeContext` 声明；未实现该方法的驱动
 * 直接跳过，因此对所有既有驱动无影响。
 */
function injectRuntimeContext(
  driver: StorageDriver,
  storageConfig: any,
  driverName: string,
  requestOrigin?: string,
): void {
  // strm 驱动需要「站点绝对地址」来把相对路径补全为可播放的完整 URL
  // （对齐 Go `common.GetApiUrl(ctx)`）。origin 属于请求级上下文，
  // 每次命中缓存都要刷新，否则冷启动后第一个请求的 origin 会被永久固化。
  const strmTarget = driver as StorageDriver & {
    setSiteBaseUrl?: (url: string) => void
  }
  if (typeof strmTarget.setSiteBaseUrl === "function" && requestOrigin) {
    try {
      strmTarget.setSiteBaseUrl(requestOrigin)
    } catch (e) {
      console.warn(`[${driverName}] failed to inject site base url:`, e)
    }
  }

  const target = driver as StorageDriver & {
    setRuntimeContext?: (ctx: { storageId?: any; env?: any }) => void
  }
  if (typeof target.setRuntimeContext !== "function") return
  try {
    target.setRuntimeContext({
      storageId: storageConfig?.id,
      env: getEnvCtx(),
    })
  } catch (e) {
    console.warn(`[${driverName}] failed to inject runtime context:`, e)
  }
}

function isCloud189Driver(driverName: string): boolean {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normDriver === "189" ||
    normDriver === "189cloud" ||
    normDriver === "cloud189" ||
    normDriver === "ctyun" ||
    normDriver === "189pan"
  )
}

export async function scheduleStoragePersistence(
  waitUntil: StorageRequestContext["waitUntil"],
  persistence: Promise<unknown>,
): Promise<void> {
  if (waitUntil) {
    try {
      waitUntil(persistence)
      return
    } catch {
      // Fall back to awaiting when the execution context is unavailable.
    }
  }
  await persistence
}

async function persistStorageCookie(
  storageConfig: any,
  cookie: string,
): Promise<void> {
  const storageId = String(storageConfig?.id || "")
  if (!storageId) return

  const previous = cookiePersistenceCache.get(storageId)
  const task = (previous || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const db = await getDb()
      const st = (db.storages || []).find(
        (candidate: any) => String(candidate.id) === storageId,
      )
      if (!st) return

      const stAddition =
        typeof st.addition === "string"
          ? JSON.parse(st.addition || "{}")
          : st.addition || {}
      if (
        stAddition.cookies !== undefined ||
        isWeiyunDriver(storageConfig?.driver)
      ) {
        stAddition.cookies = cookie
      } else {
        stAddition.cookie = cookie
      }
      st.addition = JSON.stringify(stAddition)
      if (String(storageConfig?.id) === storageId) {
        storageConfig.addition = st.addition
      }
      await saveDb(db)
    })

  cookiePersistenceCache.set(storageId, task)
  try {
    await task
  } finally {
    if (cookiePersistenceCache.get(storageId) === task) {
      cookiePersistenceCache.delete(storageId)
    }
  }
}

function isWeiyunDriver(driverName: string): boolean {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normDriver === "weiyun" ||
    normDriver === "tencentweiyun" ||
    normDriver === "txweiyun" ||
    normDriver.includes("weiyun")
  )
}

export async function flushPendingDriverState(
  driverName: string,
  storageConfig: any,
  driver: StorageDriver,
  requestContext?: StorageRequestContext,
): Promise<void> {
  // 139：把本轮建立的路径索引落盘。
  //
  // 索引是"解析成本不随目录深度增长"的关键（139 接口只支持按父目录 ID
  // 逐层查询），需要跨请求持久化。这里每请求最多产生 1 次 KV 写，
  // 避免撞上平台的子请求配额。
  // 139 与 189 共用同一套路径索引（KV 键按驱动命名空间隔离）。
  //
  // 天翼云盘（189）的接口与 139 同属「只认目录 ID、不支持按路径定位」，
  // 解析一层深层目录要从根逐级 `getFiles`，而 CF Workers 的 isolate
  // 在 AMS/LHR 等边缘节点间漂移，进程内 pathIdCache 命中率极低 ——
  // 实测深层目录 PROPFIND 稳定 3~10 秒并因此触发播放器超时。
  // 接入同样的持久化索引后，解析成本不再随目录深度增长。
  if (isYun139Driver(driverName) || isCloud189Driver(driverName)) {
    const flushState = (
      driver as StorageDriver & { flushState?: () => Promise<void> }
    ).flushState
    if (typeof flushState === "function") {
      try {
        await flushState.call(driver)
      } catch (e) {
        console.warn(`[${driverName}] failed to flush path index:`, e)
      }
    }
    // 释放本轮的 KV 读取预算，让下一个请求可以重新读一次索引。
    // 不重置的话计数会跨请求累积，跑几次之后就永远读不到 KV 了。
    try {
      resetPathIndexRequestBudget()
    } catch {
      // 忽略：预算未重置只影响跨请求的索引复用，不影响功能
    }

    // ── 直链 / 目录缓存落盘 ─────────────────────────────────────────────
    //
    // 这一步是**整个缓存方案能否生效的关键**。
    //
    // CF Workers 的 isolate 会在 AMS/LHR 等机房之间漂移 —— 实测同一客户端
    // 连续请求会落到不同机房，进程内 Map 命中率极低。缓存只有写进 KV 才能
    // 真正跨请求复用；而 KV 写入走防抖，需要有人在请求结束前"推一把"。
    //
    // 不落盘的后果：直链缓存恒不命中 → 每次播放仍然是一次跨洲往返 →
    // 耗时仍在 2~14 秒波动 → 播放器继续报「WebDAV 地址错误」。
    try {
      const ctxEnv = (driver as any).envCtx ?? requestContext?.env
      await flushLinkCacheStore(ctxEnv)
    } catch (e) {
      console.warn(`[${driverName}] failed to flush link cache:`, e)
    }
  }

  if (!isCloud189Driver(driverName) && !isWeiyunDriver(driverName)) return

  const consumePendingCookie = (
    driver as StorageDriver & {
      consumePendingCookie?: () => string | null
    }
  ).consumePendingCookie
  const cookie = consumePendingCookie?.call(driver)
  if (!cookie) return

  const persistence = persistStorageCookie(storageConfig, cookie).catch((e) => {
    console.warn(`[${driverName}] failed to persist cookie:`, e)
  })
  await scheduleStoragePersistence(requestContext?.waitUntil, persistence)
}

/** 判断是否为 139 云盘驱动 */
function isYun139Driver(driverName: string): boolean {
  const n = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    n === "139" ||
    n === "139yun" ||
    n === "caiyun" ||
    n === "hecaiyun" ||
    n.includes("139")
  )
}

export async function listItems(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ content: FileItem[]; provider: string; storage?: any }> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  let items: FileItem[] = []
  let driverName = "Virtual"

  if (resolved.storage) {
    driverName = resolved.storage.driver
    try {
      // 注入当次请求 origin：strm 驱动据此把 .strm 内容写成绝对 URL
      // （对齐 Go 的 `common.GetApiUrl(ctx)` —— Go 通过 ctx 把请求级信息
      //  一路透传到驱动，TS 版靠这个显式参数等价实现）。
      const driver = await getDriver(
        driverName,
        resolved.storage,
        requestContext?.requestOrigin,
      )
      // Get raw items from driver
      try {
        items = await driver.list(virtualPath, resolved.physical!)
      } finally {
        await flushPendingDriverState(
          driverName,
          resolved.storage,
          driver,
          requestContext,
        )
      }
      if (resolved.storage.status !== "work") {
        resolved.storage.status = "work"
        const db = await getDb(requestContext?.env)
        const st = (db.storages || []).find(
          (s: any) => s.id === resolved.storage?.id,
        )
        if (st) {
          st.status = "work"
          await saveDb(db, requestContext?.env)
        }
      }
    } catch (e: any) {
      try {
        const db = await getDb(requestContext?.env)
        const st = (db.storages || []).find(
          (s: any) => s.id === resolved.storage?.id,
        )
        if (st) {
          st.status = e.message || String(e)
          await saveDb(db, requestContext?.env)
        }
      } catch (persistErr) {
        console.warn("Failed to persist storage status:", persistErr)
      }
      throw e
    }
  } else if (!resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }

  // Merge virtual child storage mounts if we are listing a directory that contains mount points
  const db = await getDb(requestContext?.env)
  const activeStorages = (db.storages || []).filter((s: any) => !s.disabled)
  const cleanListedPath = resolved.cleanPath

  activeStorages.forEach((s: any) => {
    const mount =
      "/" + (s.mount_path || "").split("/").filter(Boolean).join("/")
    if (mount === cleanListedPath || mount === "/") return

    const prefix = cleanListedPath === "/" ? "/" : cleanListedPath + "/"
    if (mount.startsWith(prefix)) {
      const name = mount.slice(prefix.length).split("/").filter(Boolean)[0]
      if (name && !items.some((f) => f.name === name)) {
        items.push({
          name,
          size: 0,
          is_dir: true,
          modified: s.modified || new Date().toISOString(),
          sign: "",
          type: 1,
        })
      }
    }
  })

  // Ensure all items have calculated types
  items.forEach((item) => {
    if (!item.type) {
      item.type = calcFileType(item.name, item.is_dir)
    }
  })

  return { content: items, provider: driverName, storage: resolved.storage }
}

export async function getItem(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ item: FileItem; provider: string; rawUrl: string }> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    const name = resolved.cleanPath.split("/").filter(Boolean).pop() || "root"
    return {
      item: {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
      },
      provider: "Virtual",
      rawUrl: "",
    }
  }

  if (resolved.storage && resolved.relative === "/") {
    const name = resolved.cleanPath.split("/").filter(Boolean).pop() || "root"
    const addition = parseAddition(resolved.storage)
    return {
      item: {
        name,
        size: 0,
        is_dir: true,
        modified: resolved.storage.modified || new Date().toISOString(),
        sign: String(addition.root_folder_id || ""),
        type: 1,
        raw_url: "",
      },
      provider: resolved.storage.driver,
      rawUrl: `/api/p${virtualPath.startsWith("/") ? "" : "/"}${virtualPath}`,
    }
  }

  const driverName = resolved.storage ? resolved.storage.driver : "Local"
  // 与 listItems 同源：把请求 origin 透传给驱动（strm 需要它生成绝对 URL）
  const driver = await getDriver(
    driverName,
    resolved.storage,
    requestContext?.requestOrigin,
  )
  let item: FileItem
  try {
    item = await driver.get(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      driverName,
      resolved.storage,
      driver,
      requestContext,
    )
  }
  if (!item.type) {
    item.type = calcFileType(item.name, item.is_dir)
  }
  return {
    item,
    provider: driverName,
    rawUrl: buildRawUrl(virtualPath, item),
  }
}

/**
 * 计算 `/api/fs/get` 返回的 `raw_url`，**对齐 Go `server/handles/fsread.go` 的 FsGet**。
 *
 * Go 的三条分支（storage.MustProxy() 为真时第 1 条恒成立）：
 *   1. `rawURL = GenerateDownProxyURL(...)`，为空则
 *      `fmt.Sprintf("%s/p%s%s", GetApiUrl(c), utils.EncodePath(reqPath, true), query)`
 *      —— **绝对地址 + URL 编码 + 可选 `?sign=`**；
 *   2. `typeName != obj.GetName()` 时 `buildObjectAccessURL(...)`（同样走 `/p` 或 `/d`）；
 *   3. 否则用 `model.GetUrl(obj)`（驱动给的 CDN 直链）或 `fs.Link(...)` 的结果。
 *
 * 对 139 的 `.cas` 这类文件，驱动 `get()` 内部已做秒传还原并把 CDN 直链放进
 * `raw_url`（对应上面的第 3 条），这里必须**透传**它，否则 `/api/p` 代理到
 * 540 字节的占位文件，播放器拿到垃圾数据、表现为「无法播放」。
 *
 * 其余情况回退到 `/api/p{EncodePath(path)}` —— 注意必须做 URL 编码：
 * 路径里含中文与空格（如 `万人之上 (2026)`）时，未编码的 URL 会被客户端
 * 判定为非法（`InvalidURL: URL can't contain control characters`），
 * 播放器直接放弃请求。
 */
function buildRawUrl(virtualPath: string, item: FileItem): string {
  const raw = String(item?.raw_url || "")
  // 驱动给出的绝对地址（CDN 直链）优先透传，对齐 Go 的 `model.GetUrl(obj)` 分支
  if (/^https?:\/\//i.test(raw)) return raw
  const signed = virtualPath.startsWith("/") ? virtualPath : "/" + virtualPath
  return `/api/p${goEncodePath(signed)}`
}

export async function makeDirectory(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<void> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.mkdir(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}

export async function renameItem(
  virtualPath: string,
  newName: string,
  requestContext?: StorageRequestContext,
): Promise<void> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.rename(virtualPath, resolved.physical!, newName)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}

export async function removeItems(
  dir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  for (const name of names) {
    const itemVirtual = `${dir}/${name}`
    const resolved = await resolvePath(itemVirtual, requestContext?.env)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    try {
      await driver.remove(itemVirtual, resolved.physical!, [name])
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function moveItems(
  srcDir: string,
  dstDir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  for (const name of names) {
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    const srcResolved = await resolvePath(srcVirtual, requestContext?.env)
    const dstResolved = await resolvePath(dstVirtual, requestContext?.env)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    try {
      await driver.move(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function copyItems(
  srcDir: string,
  dstDir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  for (const name of names) {
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    const srcResolved = await resolvePath(srcVirtual, requestContext?.env)
    const dstResolved = await resolvePath(dstVirtual, requestContext?.env)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    try {
      await driver.copy(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function putItem(
  virtualPath: string,
  content: Buffer,
  requestContext?: StorageRequestContext,
): Promise<void> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.put(virtualPath, resolved.physical!, content)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}
