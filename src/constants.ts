/**
 * 课堂派 openapiv5 接口常量。
 *
 * 这些请求头来自对 w.ketangpai.com（微信内 H5 端）真实流量的逆向，
 * 服务端会校验 Origin/Referer，缺失时可能直接被 WAF 拦掉。
 */
export const API_BASE = "https://openapiv5.ketangpai.com";

/** 服务端认为请求来自「微信内置浏览器 + 手机」时最不容易被风控。 */
export const WECHAT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.56(0x18003835) NetType/WIFI Language/zh_CN";

export const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh-Hans;q=0.9",
  "Content-Type": "application/json",
  "User-Agent": WECHAT_UA,
  Origin: "https://w.ketangpai.com",
  Referer: "https://w.ketangpai.com/",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

/** 签到类型（来自 getNotFinishAttenceStudent 返回的 type 字段）。 */
export const ATTENCE_TYPE = {
  DIGIT: "1", // 数字码签到
  GPS: "2", // 定位签到
  QRCODE: "3", // 二维码签到
  IN_OUT: "4", // 签到 + 签出
} as const;

export const ATTENCE_TYPE_NAME: Record<string, string> = {
  "1": "数字码签到",
  "2": "定位签到",
  "3": "二维码签到",
  "4": "签到+签出",
};

/** AttenceResult（二维码签到）成功时 data.state 的值。 */
export const QR_SUCCESS_STATE = 8;
/** AttenceApi/checkin（数字码/定位）成功时 data.state 的值。 */
export const CHECKIN_SUCCESS_STATE = 1;
