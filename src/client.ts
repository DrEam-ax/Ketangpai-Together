import { API_BASE, BASE_HEADERS, CHECKIN_SUCCESS_STATE, QR_SUCCESS_STATE } from "./constants.ts";
import { httpRequest, type HttpResponse } from "./http.ts";
import { FakeIp, reqtimestamp } from "./util.ts";

export interface KtpClientOptions {
  token?: string | null;
  /** 多账号联调时的标签，仅用于日志。 */
  label?: string;
  debug?: boolean;
  fakeIpPrefixes?: string[];
}

export interface Attendance {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * 课堂派接口封装。
 *
 * 鉴权不是 Cookie，而是一个 `token` 请求头，来自 UserApi/login 的 data.token。
 * 所有业务接口都是 POST + JSON，且必须带 reqtimestamp。
 */
export class KtpClient {
  token: string | null;
  label: string;
  debug: boolean;
  readonly fakeIp: FakeIp;
  /** 最近若干次请求的原始响应，联调时用得上。 */
  readonly history: Array<{ path: string; request: unknown; response: HttpResponse }> = [];

  constructor(opts: KtpClientOptions = {}) {
    this.token = opts.token ?? null;
    this.label = opts.label ?? "user";
    this.debug = opts.debug ?? false;
    this.fakeIp = new FakeIp(opts.fakeIpPrefixes ?? []);
  }

  /** 未鉴权请求用的头（登录接口）。 */
  baseHeaders(): Record<string, string> {
    const headers = { ...BASE_HEADERS };
    const ip = this.fakeIp.next();
    if (ip) headers["X-Forwarded-For"] = ip;
    return headers;
  }

  /** 已鉴权请求用的头。 */
  authHeaders(): Record<string, string> {
    if (!this.token) throw new Error("尚未登录，没有 token");
    return { ...this.baseHeaders(), token: this.token };
  }

  async call(
    path: string,
    body: Record<string, unknown> = {},
    opts: { authed?: boolean; keepTimestamp?: boolean } = {},
  ): Promise<HttpResponse> {
    const { authed = true, keepTimestamp = false } = opts;
    const payload = keepTimestamp ? body : { ...body, reqtimestamp: reqtimestamp() };
    const res = await httpRequest(`${API_BASE}${path}`, {
      method: "POST",
      headers: authed ? this.authHeaders() : this.baseHeaders(),
      body: payload,
    });
    this.history.push({ path, request: payload, response: res });
    if (this.debug) {
      console.log(
        `[${this.label}] POST ${path} -> ${res.status} ${JSON.stringify(res.json ?? res.body).slice(0, 500)}`,
      );
    }
    return res;
  }

  /** 用邮箱/手机号 + 明文密码登录，成功返回 token。 */
  async login(email: string, password: string): Promise<string> {
    const res = await this.call(
      "/UserApi/login",
      { email, password, remember: "1", source_type: 1 },
      { authed: false },
    );
    const token = res.json?.data?.token;
    if (!token) {
      throw new Error(
        `登录失败（HTTP ${res.status}）：${JSON.stringify(res.json ?? res.body).slice(0, 500)}`,
      );
    }
    this.token = String(token);
    return this.token;
  }

  async getUserInfo(): Promise<any> {
    return (await this.call("/UserApi/getUserInfo", {})).json;
  }

  /**
   * 我加入的课程列表。
   *  - 学生端：/courseApi/simpleLists（注意是小写 courseApi，跟 CourseApi 是两个命名空间）
   *  - 教师端：/CourseApi/semesterCourseList
   */
  async getMyCourses(): Promise<Record<string, any>[]> {
    const simple = await this.call("/courseApi/simpleLists", {});
    const data = simple.json?.data;
    const lists = [...(data?.toplists ?? []), ...(data?.lists ?? [])];
    if (Array.isArray(lists) && lists.length > 0) return lists;

    const teacher = await this.call("/CourseApi/semesterCourseList", {});
    const tdata = teacher.json?.data;
    if (Array.isArray(tdata)) return tdata;
    if (tdata && typeof tdata === "object") {
      return Object.values(tdata).flat() as Record<string, any>[];
    }
    return [];
  }

  /** 我这学期加入的全部课程（学生端课程列表）。 */
  async getSemesterCourseList(): Promise<any[]> {
    const json = (await this.call("/CourseApi/semesterCourseList", {})).json;
    const data = json?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") return Object.values(data).flat() as any[];
    return [];
  }

  /** 取某个签到的当前二维码票据（教师端接口，需验证学生 token 是否有权限）。 */
  async getQrCode(attenceid: string): Promise<HttpResponse> {
    return this.call("/AttenceApi/getQrCode", { attenceid });
  }

  /** 当前课程下「我还没完成」的签到列表。二维码签到就靠它发现。 */
  async getNotFinishAttendance(courseid: string): Promise<Attendance[]> {
    const json = (await this.call("/AttenceApi/getNotFinishAttenceStudent", { courseid })).json;
    const list = json?.data?.lists ?? json?.data?.list ?? [];
    return Array.isArray(list) ? (list as Attendance[]) : [];
  }

  /**
   * 通用签到提交（数字码 / 定位 / 签到签出）。
   * 对二维码签到（type=3）也试一下，用来验证服务端是否真的强制要 ticketid。
   */
  async checkin(params: {
    id: string;
    code?: string;
    latitude?: string;
    longitude?: string;
    unusual?: string;
    clienttype?: number;
  }): Promise<HttpResponse> {
    return this.call("/AttenceApi/checkin", {
      id: params.id,
      code: params.code ?? "",
      unusual: params.unusual ?? "",
      latitude: params.latitude ?? "",
      longitude: params.longitude ?? "",
      accuracy: "",
      clienttype: params.clienttype ?? 1,
    });
  }

  static checkinSucceeded(json: any): boolean {
    return json?.data?.state === CHECKIN_SUCCESS_STATE;
  }

  /** 数字码签到：取服务端下发的数字码。 */
  async getDigitAttendance(id: string): Promise<HttpResponse> {
    return this.call("/AttenceApi/getDigitAttence", { id });
  }

  /** 二维码签到：唯一被证明有效的提交方式。 */
  async submitQrTicket(ticket: {
    ticketid: string;
    expire: string;
    sign: string;
  }): Promise<HttpResponse> {
    return this.call("/AttenceApi/AttenceResult", {
      ticketid: ticket.ticketid,
      expire: ticket.expire,
      sign: ticket.sign,
    });
  }

  static qrSucceeded(json: any): boolean {
    return json?.data?.state === QR_SUCCESS_STATE;
  }
}
