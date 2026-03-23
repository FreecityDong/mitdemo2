const state = {
  referenceData: null,
  auth: null,
  patientDashboard: null,
  doctorDashboard: null,
  doctorPatientDetail: null,
  familyDashboard: null,
  selectedRideId: null,
  selectedDoctorPatientId: null,
  activeRide: null,
  stream: null,
  amapLoadPromise: null,
  patientMap: null,
  patientMapReady: false,
  currentLocation: null,
  locatingPosition: false,
  notificationSeenIds: new Set(),
  notificationBootstrapped: false,
  notificationPoller: null,
};

const appRoot = document.getElementById("appRoot");
const sessionBar = document.getElementById("sessionBar");
const toastHost = document.getElementById("toastHost");
const TOKEN_STORAGE_KEY = "kangqei-demo-token";

function getStoredToken() {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

function storeToken(token) {
  if (token) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function roleLabel(role) {
  if (role === "patient") return "患者";
  if (role === "doctor") return "医生";
  if (role === "family") return "家属";
  return role;
}

function levelLabel(level) {
  if (level === "high") return "HIGH";
  if (level === "medium") return "MEDIUM";
  if (level === "low") return "LOW";
  return "SAFE";
}

function directionLabel(direction) {
  if (direction === "rear_left") return "左后方";
  if (direction === "rear_right") return "右后方";
  return "正后方";
}

async function fetchJson(url, options = {}) {
  const token = getStoredToken();
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      storeToken(null);
    }
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function showToast(title, message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<strong>${title}</strong><div>${message}</div>`;
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function setAuthContext(authContext) {
  state.auth = authContext?.user ? authContext : null;
  storeToken(authContext?.token || null);
  state.notificationSeenIds = new Set();
  state.notificationBootstrapped = false;
  renderSessionBar();
}

function clearAppState() {
  stopNotificationPolling();
  closeRideStream();
  destroyPatientMap();
  storeToken(null);
  state.auth = null;
  state.patientDashboard = null;
  state.doctorDashboard = null;
  state.doctorPatientDetail = null;
  state.familyDashboard = null;
  state.activeRide = null;
  state.currentLocation = null;
  state.locatingPosition = false;
  state.selectedRideId = null;
  state.selectedDoctorPatientId = null;
  state.notificationSeenIds = new Set();
  state.notificationBootstrapped = false;
  renderSessionBar();
}

function formatCoordinate(value) {
  return typeof value === "number" ? value.toFixed(6) : "--";
}

function formatAccuracy(value) {
  return typeof value === "number" ? `${Math.round(value)} 米` : "--";
}

function locationSummary(location) {
  if (!location) {
    return "尚未获取定位";
  }
  return `${formatCoordinate(location.lat)}, ${formatCoordinate(location.lng)}`;
}

function buildStartLocationCard(location, title, note) {
  if (!location) {
    return `
      <div class="card">
        <strong>${title}</strong>
        <div class="meta">${note}</div>
        <div class="panel-note">暂无坐标</div>
      </div>
    `;
  }
  return `
    <div class="card">
      <strong>${title}</strong>
      <div class="meta">${note}</div>
      <div>${formatCoordinate(location.lat)}, ${formatCoordinate(location.lng)}</div>
      <div class="panel-note">精度 ${formatAccuracy(location.accuracy)}</div>
    </div>
  `;
}

function destroyPatientMap() {
  if (state.patientMap) {
    state.patientMap.destroy();
    state.patientMap = null;
  }
  state.patientMapReady = false;
}

function getAmapConfig() {
  return state.referenceData?.mapProvider || { enabled: false, webKey: null };
}

function ensureAmapLoaded() {
  const amapConfig = getAmapConfig();
  if (!amapConfig.enabled || !amapConfig.webKey) {
    return Promise.resolve(null);
  }

  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }

  if (state.amapLoadPromise) {
    return state.amapLoadPromise;
  }

  state.amapLoadPromise = new Promise((resolve, reject) => {
    const existingScript = document.getElementById("amap-jsapi");
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.AMap));
      existingScript.addEventListener("error", () => reject(new Error("高德地图脚本加载失败。")));
      return;
    }

    const script = document.createElement("script");
    script.id = "amap-jsapi";
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(
      amapConfig.webKey,
    )}&plugin=AMap.Geolocation,AMap.ToolBar,AMap.Scale`;
    script.async = true;
    script.onload = () => resolve(window.AMap);
    script.onerror = () => reject(new Error("高德地图脚本加载失败。"));
    document.head.appendChild(script);
  });

  return state.amapLoadPromise;
}

async function ensurePatientMap() {
  const mapNode = document.getElementById("patientMap");
  if (!mapNode) {
    return null;
  }

  const AMap = await ensureAmapLoaded();
  if (!AMap) {
    mapNode.innerHTML = `
      <div class="map-placeholder">
        <strong>未启用高德地图</strong>
        <div>请在 .env 中配置 AMAP_WEB_KEY 后重新启动服务。</div>
      </div>
    `;
    return null;
  }

  if (state.patientMap) {
    return state.patientMap;
  }

  const center = state.currentLocation
    ? [state.currentLocation.lng, state.currentLocation.lat]
    : [121.4737, 31.2304];
  const map = new AMap.Map("patientMap", {
    zoom: state.currentLocation ? 15 : 12,
    center,
    viewMode: "2D",
  });

  map.addControl(new AMap.ToolBar());
  map.addControl(new AMap.Scale());

  state.patientMap = map;
  state.patientMapReady = true;
  return map;
}

async function refreshPatientMap() {
  const map = await ensurePatientMap();
  if (!map) {
    return;
  }

  const points = [];
  map.clearMap();

  if (state.currentLocation) {
    const marker = new window.AMap.Marker({
      position: [state.currentLocation.lng, state.currentLocation.lat],
      title: "当前位置",
    });
    map.add(marker);
    points.push([state.currentLocation.lng, state.currentLocation.lat]);
  }

  const rideLocation = state.activeRide?.startLocation || state.patientDashboard?.recentRides?.[0]?.startLocation || null;
  if (rideLocation) {
    const marker = new window.AMap.Marker({
      position: [rideLocation.lng, rideLocation.lat],
      title: "骑行起点",
      label: {
        direction: "top",
        content: '<div class="map-marker-label">骑行起点</div>',
      },
    });
    map.add(marker);
    points.push([rideLocation.lng, rideLocation.lat]);
  }

  if (points.length === 1) {
    map.setZoomAndCenter(15, points[0]);
  } else if (points.length > 1) {
    map.setFitView();
  }
}

async function locateCurrentPosition(showErrors = true) {
  const map = await ensurePatientMap();
  if (!map || !window.AMap) {
    if (showErrors) {
      window.alert("高德地图未启用，请先配置 AMAP_WEB_KEY。");
    }
    return null;
  }

  state.locatingPosition = true;
  renderPatientView();

  return new Promise((resolve) => {
    window.AMap.plugin("AMap.Geolocation", () => {
      const geolocation = new window.AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
        zoomToAccuracy: true,
      });

      geolocation.getCurrentPosition((status, result) => {
        state.locatingPosition = false;
        if (status === "complete" && result?.position) {
          state.currentLocation = {
            lat: result.position.lat,
            lng: result.position.lng,
            accuracy: result.accuracy ?? null,
            updatedAt: new Date().toISOString(),
            source: "amap",
          };
          renderPatientView();
          showToast("定位成功", "已通过高德定位获取当前位置，可作为本次骑行起点。");
          resolve(state.currentLocation);
          return;
        }

        renderPatientView();
        if (showErrors) {
          window.alert("无法通过高德获取当前位置，请检查定位权限、网络或 Web Key 配置。");
        }
        resolve(null);
      });
    });
  });
}

function renderSessionBar() {
  if (!state.auth?.user) {
    sessionBar.innerHTML = "";
    return;
  }

  sessionBar.innerHTML = `
    <div class="user-chip">
      <div>
        <div><strong>${state.auth.user.name}</strong></div>
        <div class="meta">${state.auth.user.email}</div>
      </div>
      <span class="role-badge">${roleLabel(state.auth.user.role)}</span>
      <button class="text-button" data-action="logout">退出登录</button>
    </div>
  `;
}

function notificationCards(notifications) {
  if (!notifications?.length) {
    return '<div class="empty-state">暂无通知。</div>';
  }

  return notifications
    .map(
      (item) => `
        <div class="notification-card ${item.isRead ? "" : "unread"}">
          <div class="button-row" style="justify-content: space-between;">
            <strong>${item.title}</strong>
            ${item.isRead ? "" : `<button class="secondary" data-action="mark-notification" data-id="${item.id}">标记已读</button>`}
          </div>
          <div>${item.message}</div>
          <div class="meta">${new Date(item.createdAt).toLocaleString()}</div>
        </div>
      `,
    )
    .join("");
}

function reportSummaryCard(report) {
  if (!report) {
    return '<div class="empty-state">暂无骑行报告。</div>';
  }
  return `
    <div class="summary-card">
      <div class="summary-grid">
        <div class="metric-card">
          <span>安全评分</span>
          <strong>${report.safetyScore}</strong>
        </div>
        <div class="metric-card">
          <span>高风险事件</span>
          <strong>${report.highRiskCount}</strong>
        </div>
        <div class="metric-card">
          <span>总时长</span>
          <strong>${report.rideDurationMinutes} 分钟</strong>
        </div>
        <div class="metric-card">
          <span>总预警数</span>
          <strong>${report.totalAlerts}</strong>
        </div>
      </div>
      <div><strong>医生建议：</strong>${report.doctorComment}</div>
      <div><strong>路线建议：</strong></div>
      <div class="info-list">
        ${report.recommendations.map((item) => `<div class="card">${item}</div>`).join("")}
      </div>
    </div>
  `;
}

function rideHistoryCards(rides, context = "patient") {
  if (!rides?.length) {
    return '<div class="empty-state">暂无骑行记录。</div>';
  }

  return rides
    .map((ride) => `
      <div class="ride-card">
        <div class="button-row" style="justify-content: space-between;">
          <strong>${ride.scenarioName}</strong>
          <button class="secondary" data-action="view-ride" data-id="${ride.id}" data-context="${context}">查看详情</button>
        </div>
        <div class="meta">${ride.status === "finished" ? "已结束" : "进行中"} · ${ride.startedAt ? new Date(ride.startedAt).toLocaleString() : "未开始"}</div>
        <div>风险事件 ${ride.totalRiskEvents || ride.events?.length || 0} 次</div>
        <div>安全评分 ${ride.report?.safetyScore ?? ride.finalSafetyScore ?? "--"}</div>
      </div>
    `)
    .join("");
}

function renderRoadTargets(targets) {
  return targets
    .map((target) => {
      const top = Math.min(280, Math.max(44, 300 - target.distance * 10));
      const pos = target.direction === "rear_left" ? "left" : target.direction === "rear_right" ? "right" : "center";
      return `
        <div class="target ${target.type} ${pos}" style="top:${top}px">
          <div>${target.type.toUpperCase()}</div>
          <strong>${target.distance.toFixed(1)}m</strong>
        </div>
      `;
    })
    .join("");
}

function hudClass(level, direction, targetDirection) {
  if (level === "safe" || direction !== targetDirection) {
    return "hud";
  }
  return `hud ${direction.includes("left") ? "left" : direction.includes("right") ? "right" : "center"} active ${level}`;
}

function liveRideSection(ride) {
  if (!ride?.currentState) {
    return `
      <div class="panel">
        <div class="panel-header">
          <h3>实时骑行</h3>
          <p>开始骑行后，这里会展示道路场景、眼镜预警和后方目标。</p>
        </div>
        <div class="empty-state">当前没有进行中的骑行会话。</div>
      </div>
    `;
  }

  const risk = ride.currentState.risk;
  const target = risk.primaryTarget;
  const targetDirection = target?.direction || "";

  return `
    <div class="panel panel-strong">
      <div class="panel-header">
        <h3>实时骑行</h3>
        <p>${ride.scenario.name} · ${ride.status === "active" ? "会话进行中" : "会话已结束"}</p>
      </div>
      <div class="card-stack">
        <div class="road-stage">
          <div class="lane left"></div>
          <div class="lane right"></div>
          <div class="road-overlay">
            <div>
              <div class="overlay-tag">Rear Radar Feed</div>
              <div>${target ? `${target.type.toUpperCase()} ${target.distance.toFixed(1)}m · ${risk.reason}` : "当前后方无目标"}</div>
            </div>
            <div class="pill">T${ride.currentState.tick}</div>
          </div>
          <div class="rider">骑行者</div>
          ${renderRoadTargets(ride.currentState.targets)}
        </div>
        <div class="glasses-panel">
          <div class="glasses-frame">
            <div class="lens"></div>
            <div class="bridge"></div>
            <div class="lens"></div>
            <div class="${hudClass(risk.level, "rear_left", targetDirection)}"></div>
            <div class="${hudClass(risk.level, "rear_center", targetDirection)}"></div>
            <div class="${hudClass(risk.level, "rear_right", targetDirection)}"></div>
          </div>
          <div class="alert-banner">
            <div class="alert-level ${risk.level}">${levelLabel(risk.level)}</div>
            <div>${risk.reason}</div>
          </div>
          <div class="metric-grid">
            <div class="metric-card"><span>最近距离</span><strong>${target ? `${target.distance.toFixed(1)}m` : "--"}</strong></div>
            <div class="metric-card"><span>相对速度</span><strong>${target ? `${target.relativeSpeed}km/h` : "--"}</strong></div>
            <div class="metric-card"><span>TTC</span><strong>${risk.ttc ? `${risk.ttc}s` : "--"}</strong></div>
            <div class="metric-card"><span>风险等级</span><strong>${levelLabel(risk.level)}</strong></div>
          </div>
          <div class="status-grid">
            <div class="status-card"><span>雷达</span><strong>${ride.currentState.deviceState.radarOnline ? "在线" : "离线"}</strong></div>
            <div class="status-card"><span>眼镜</span><strong>${ride.currentState.deviceState.glassesOnline ? "在线" : "离线"}</strong></div>
            <div class="status-card"><span>App</span><strong>${ride.currentState.deviceState.appOnline ? "在线" : "离线"}</strong></div>
            <div class="status-card"><span>电量</span><strong>${ride.currentState.deviceState.batteryLevel}%</strong></div>
          </div>
          <div class="button-row">
            <button class="danger" data-action="finish-ride" data-id="${ride.id}" ${ride.status !== "active" ? "disabled" : ""}>结束骑行</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function eventTimeline(events) {
  if (!events?.length) {
    return '<div class="empty-state">暂无风险事件。</div>';
  }
  return events
    .slice()
    .reverse()
    .map(
      (event) => `
        <div class="event-card ${event.riskLevel}">
          <strong>T${event.tick} · ${levelLabel(event.riskLevel)}</strong>
          <div>${event.reason}</div>
          <div class="meta">${event.distance}m / ${event.relativeSpeed}km/h / TTC ${event.ttc ?? "--"}s</div>
        </div>
      `,
    )
    .join("");
}

function renderAuthView() {
  appRoot.innerHTML = `
    <section class="auth-grid">
      <div class="panel hero-card">
        <div class="panel-header">
          <h2>完整多角色演示平台</h2>
          <p>这不是单纯的前端动画，而是一个有数据库、账号体系、角色权限、医生干预、家属通知和实时骑行会话的完整演示系统。</p>
        </div>
        <div class="hero-kpis">
          <div class="kpi"><span>数据库</span><strong>SQLite</strong></div>
          <div class="kpi"><span>角色</span><strong>患者 / 医生 / 家属</strong></div>
          <div class="kpi"><span>实时链路</span><strong>SSE + 会话状态</strong></div>
        </div>
        <div class="card-stack">
          <div class="card">患者：建档、开始骑行、实时预警、报告查看、接收医生动作通知。</div>
          <div class="card">医生：查看患者、调整阈值、标记患者状态、查看风险记录。</div>
          <div class="card">家属：关联患者、接收高风险/报告提醒、查看最近安全状态。</div>
          <div class="card">演示医生默认账号：<strong>doctor@demo.com</strong> / <strong>demo1234</strong></div>
        </div>
      </div>

      <div class="stack">
        <div class="panel panel-strong">
          <div class="panel-header">
            <h2>登录</h2>
            <p>使用已注册账号登录。医生可直接使用默认演示账号。</p>
          </div>
          <form id="loginForm" class="form-stack">
            <label class="field"><span>邮箱</span><input name="email" type="email" required /></label>
            <label class="field"><span>密码</span><input name="password" type="password" required /></label>
            <button class="primary" type="submit">登录</button>
          </form>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2>注册</h2>
            <p>创建患者、医生或家属角色账号。患者注册时会同时建立康复档案。</p>
          </div>
          <form id="registerForm" class="form-stack">
            <label class="field"><span>姓名</span><input name="name" required /></label>
            <label class="field"><span>邮箱</span><input name="email" type="email" required /></label>
            <label class="field"><span>密码</span><input name="password" type="password" required minlength="6" /></label>
            <label class="field">
              <span>角色</span>
              <select name="role" id="registerRole">
                <option value="patient">患者</option>
                <option value="doctor">医生</option>
                <option value="family">家属</option>
              </select>
            </label>
            <div id="patientRegistrationFields" class="form-stack">
              <label class="field">
                <span>康复模板</span>
                <select name="templateProfileId">
                  ${state.referenceData.referenceProfiles.map((item) => `<option value="${item.id}">${item.name}</option>`).join("")}
                </select>
              </label>
              <div class="two-col">
                <label class="field"><span>年龄</span><input name="age" type="number" min="1" max="120" /></label>
                <label class="field">
                  <span>性别</span>
                  <select name="gender">
                    <option value="未说明">未说明</option>
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </label>
              </div>
            </div>
            <button class="primary" type="submit">注册并进入系统</button>
          </form>
        </div>
      </div>
    </section>
  `;
}

function renderPatientView() {
  const data = state.patientDashboard;
  const selectedRide =
    data?.recentRides?.find((ride) => ride.id === state.selectedRideId) ||
    data?.activeRide ||
    data?.recentRides?.[0] ||
    null;

  appRoot.innerHTML = `
    <section class="dashboard-grid">
      <aside class="panel">
        <div class="panel-header">
          <h2>患者面板</h2>
          <p>完成建档后的用户可从这里发起骑行会话、查看当前状态与历史报告。</p>
        </div>
        <div class="card-stack">
          <div class="card">
            <strong>${data.user.name}</strong>
            <div>${data.patientProfile.conditionType} / ${data.patientProfile.rehabStage}</div>
            <div class="meta">当前状态：${data.patientProfile.patientStatus}</div>
            <div class="meta">有效敏感度：${data.patientProfile.effectiveSensitivity}</div>
          </div>

          <div class="card-stack">
            <label class="field">
              <span>骑行场景</span>
              <select id="patientScenarioSelect">
                ${data.scenarios.map((scenario) => `<option value="${scenario.id}">${scenario.name}</option>`).join("")}
              </select>
            </label>
            <div class="button-row">
              <button class="secondary" data-action="locate-me" ${state.locatingPosition ? "disabled" : ""}>
                ${state.locatingPosition ? "定位中..." : "定位当前位置"}
              </button>
              <button class="primary" data-action="start-ride" ${data.activeRide ? "disabled" : ""}>开始骑行</button>
            </div>
            ${buildStartLocationCard(state.currentLocation, "当前位置", "开始骑行前会用这个坐标作为起点")}
          </div>

          <div class="card-stack">
            <h3>通知中心</h3>
            <div class="notification-list">${notificationCards(data.notifications)}</div>
          </div>
        </div>
      </aside>

      <section class="stack">
        <div class="panel">
          <div class="panel-header">
            <h3>骑行地图</h3>
            <p>已切换为高德 JS 地图与定位。开始骑行前可通过高德定位到当前位置，并将坐标写入本次骑行起点。</p>
          </div>
          <div id="patientMap" class="patient-map"></div>
          <div class="card-stack" style="margin-top: 12px;">
            ${buildStartLocationCard(state.currentLocation, "当前位置", "浏览器定位结果")}
            ${buildStartLocationCard(data.activeRide?.startLocation || selectedRide?.startLocation, "骑行起点", "最近一次或当前骑行会话记录")}
          </div>
        </div>

        ${liveRideSection(data.activeRide)}

        <div class="panel">
          <div class="panel-header">
            <h3>风险事件时间线</h3>
            <p>展示当前或已选中骑行的关键风险节点。</p>
          </div>
          <div class="timeline-list">${eventTimeline(selectedRide?.events || data.activeRide?.events || [])}</div>
        </div>
      </section>

      <aside class="stack">
        <div class="panel">
          <div class="panel-header">
            <h3>骑行历史</h3>
            <p>点击查看某次骑行的详细报告。</p>
          </div>
          <div class="card-stack">${rideHistoryCards(data.recentRides, "patient")}</div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h3>报告详情</h3>
            <p>${selectedRide ? `${selectedRide.scenarioName} 的报告摘要` : "尚未生成报告。"}</p>
          </div>
          ${reportSummaryCard(selectedRide?.report)}
        </div>
      </aside>
    </section>
  `;

  refreshPatientMap();
}

function renderDoctorView() {
  const data = state.doctorDashboard;
  const detail = state.doctorPatientDetail;

  appRoot.innerHTML = `
    <section class="dashboard-grid">
      <aside class="panel">
        <div class="panel-header">
          <h2>医生工作台</h2>
          <p>查看患者档案、最近骑行、调整预警阈值，并标记患者当前骑行建议状态。</p>
        </div>
        <div class="card-stack">
          ${data.patients.length
            ? data.patients
                .map(
                  (patient) => `
                    <div class="patient-card">
                      <div class="button-row" style="justify-content: space-between;">
                        <strong>${patient.name}</strong>
                        <button class="secondary" data-action="select-patient" data-id="${patient.id}">查看</button>
                      </div>
                      <div>${patient.conditionType} / ${patient.rehabStage}</div>
                      <div class="meta">状态：${patient.patientStatus}</div>
                      <div class="meta">阈值系数：${patient.doctorThresholdAdjustment}</div>
                    </div>
                  `,
                )
                .join("")
            : '<div class="empty-state">暂无患者注册。</div>'}
        </div>
      </aside>

      <section class="stack">
        <div class="panel panel-strong">
          <div class="panel-header">
            <h3>患者详情</h3>
            <p>${detail ? `当前查看：${detail.patient.name}` : "请选择左侧患者。"}</p>
          </div>
          ${
            detail
              ? `
                <div class="card-stack">
                  <div class="summary-card">
                    <div><strong>${detail.patient.name}</strong> · ${detail.patient.email}</div>
                    <div>${detail.profile.conditionType} / ${detail.profile.rehabStage}</div>
                    <div class="meta">当前状态：${detail.profile.patientStatus}</div>
                  </div>

                  <div class="two-col">
                    <form id="thresholdForm" class="panel panel-strong">
                      <div class="panel-header">
                        <h4>调整预警阈值</h4>
                        <p>改变患者的风险敏感度，影响中高风险触发时机。</p>
                      </div>
                      <input type="hidden" name="patientId" value="${detail.patient.id}" />
                      <label class="field">
                        <span>阈值调整系数</span>
                        <input name="adjustment" type="number" min="0.7" max="1.8" step="0.05" value="${detail.profile.doctorThresholdAdjustment}" />
                      </label>
                      <button class="primary" type="submit">保存阈值</button>
                    </form>

                    <form id="statusForm" class="panel panel-strong">
                      <div class="panel-header">
                        <h4>标记患者状态</h4>
                        <p>为后续骑行建议选择当前状态。</p>
                      </div>
                      <input type="hidden" name="patientId" value="${detail.patient.id}" />
                      <label class="field">
                        <span>患者状态</span>
                        <select name="status">
                          ${state.referenceData.patientStatuses
                            .map((status) => `<option value="${status}" ${status === detail.profile.patientStatus ? "selected" : ""}>${status}</option>`)
                            .join("")}
                        </select>
                      </label>
                      <button class="primary" type="submit">更新状态</button>
                    </form>
                  </div>

                  <div class="panel">
                    <div class="panel-header">
                      <h4>患者最近骑行</h4>
                      <p>查看这位患者最近的风险事件和报告。</p>
                    </div>
                    <div class="card-stack">${rideHistoryCards(detail.recentRides, "doctor")}</div>
                  </div>
                </div>
              `
              : '<div class="empty-state">左侧选择一位患者后，这里会显示可操作表单。</div>'
          }
        </div>

        <div class="panel">
          <div class="panel-header">
            <h3>医生操作记录</h3>
            <p>展示最近对该患者做过的阈值调整和状态标记。</p>
          </div>
          <div class="timeline-list">
            ${
              detail?.doctorActions?.length
                ? detail.doctorActions
                    .map(
                      (action) => `
                        <div class="event-card">
                          <strong>${action.actionType === "threshold_adjustment" ? "阈值调整" : "状态标记"}</strong>
                          <div>${JSON.stringify(action.payload)}</div>
                          <div class="meta">${new Date(action.createdAt).toLocaleString()}</div>
                        </div>
                      `,
                    )
                    .join("")
                : '<div class="empty-state">暂无操作记录。</div>'
            }
          </div>
        </div>
      </section>

      <aside class="stack">
        <div class="panel">
          <div class="panel-header">
            <h3>通知中心</h3>
            <p>家属链接、患者高风险事件和骑行报告都会出现在这里。</p>
          </div>
          <div class="notification-list">${notificationCards(data.notifications)}</div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h3>最新报告</h3>
            <p>${detail?.latestReport ? `${detail.patient.name} 的最新报告` : "请选择患者查看报告。"}</p>
          </div>
          ${reportSummaryCard(detail?.latestReport)}
        </div>
      </aside>
    </section>
  `;
}

function renderFamilyView() {
  const data = state.familyDashboard;

  appRoot.innerHTML = `
    <section class="dashboard-grid">
      <aside class="panel">
        <div class="panel-header">
          <h2>家属面板</h2>
          <p>输入患者邮箱完成关联。之后即可收到高风险事件提醒和骑行总结通知。</p>
        </div>
        <form id="familyLinkForm" class="form-stack">
          <label class="field"><span>患者邮箱</span><input name="patientEmail" type="email" required placeholder="patient@example.com" /></label>
          <button class="primary" type="submit">关联患者</button>
        </form>
        <div class="panel-header" style="margin-top: 20px;">
          <h3>通知中心</h3>
        </div>
        <div class="notification-list">${notificationCards(data.notifications)}</div>
      </aside>

      <section class="stack">
        <div class="panel panel-strong">
          <div class="panel-header">
            <h3>已关联患者</h3>
            <p>查看当前骑行状态、医生标记状态和最新报告。</p>
          </div>
          <div class="card-stack">
            ${
              data.linkedPatients.length
                ? data.linkedPatients
                    .map(
                      (patient) => `
                        <div class="summary-card">
                          <div class="button-row" style="justify-content: space-between;">
                            <strong>${patient.name}</strong>
                            <span class="role-badge">${patient.profile.patientStatus}</span>
                          </div>
                          <div>${patient.profile.conditionType} / ${patient.profile.rehabStage}</div>
                          <div class="meta">${patient.activeRide ? `当前正在 ${patient.activeRide.scenario.name} 骑行` : "当前无进行中的骑行"}</div>
                          <div class="panel-note">有效敏感度：${patient.profile.effectiveSensitivity}</div>
                          <div class="panel-note">推荐时长：${patient.profile.recommendedDuration} 分钟</div>
                        </div>
                      `,
                    )
                    .join("")
                : '<div class="empty-state">还没有关联患者。请输入患者邮箱完成绑定。</div>'
            }
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h3>最近骑行摘要</h3>
            <p>家属可快速查看最新一次骑行的安全情况。</p>
          </div>
          <div class="card-stack">
            ${
              data.linkedPatients.length
                ? data.linkedPatients
                    .map(
                      (patient) => `
                        <div class="summary-card">
                          <div><strong>${patient.name}</strong></div>
                          ${reportSummaryCard(patient.latestReport)}
                        </div>
                      `,
                    )
                    .join("")
                : '<div class="empty-state">暂无可展示的骑行摘要。</div>'
            }
          </div>
        </div>
      </section>

      <aside class="panel">
        <div class="panel-header">
          <h3>家属说明</h3>
          <p>本页的通知为页面内推送模拟。当患者出现高风险事件或完成骑行报告后，家属端会出现新消息。</p>
        </div>
        <div class="card-stack">
          <div class="card">高风险提醒：用于模拟“请关注患者当前骑行状态”。</div>
          <div class="card">报告提醒：用于模拟“骑行结束，已生成安全报告”。</div>
          <div class="card">医生动作提醒：当医生调整患者状态时，家属也会同步看到。</div>
        </div>
      </aside>
    </section>
  `;
}

async function loadPatientDashboard() {
  const data = await fetchJson("/api/patient/dashboard");
  state.patientDashboard = data;
  state.activeRide = data.activeRide;
  if (!state.selectedRideId && data.recentRides?.length) {
    state.selectedRideId = data.recentRides[0].id;
  }
  syncNotifications(data.notifications);
  renderPatientView();
  syncRideStream();
  if (!state.currentLocation && !data.activeRide) {
    locateCurrentPosition(false).catch(console.error);
  }
}

async function loadDoctorDashboard(selectPatientId = null) {
  const data = await fetchJson("/api/doctor/dashboard");
  state.doctorDashboard = data;
  syncNotifications(data.notifications);

  const targetId = selectPatientId || state.selectedDoctorPatientId || data.patients[0]?.id;
  state.selectedDoctorPatientId = targetId || null;

  if (targetId) {
    state.doctorPatientDetail = await fetchJson(`/api/doctor/patients/${targetId}`);
  } else {
    state.doctorPatientDetail = null;
  }

  renderDoctorView();
}

async function loadFamilyDashboard() {
  const data = await fetchJson("/api/family/dashboard");
  state.familyDashboard = data;
  syncNotifications(data.notifications);
  renderFamilyView();
}

async function loadRoleView() {
  closeRideStream();
  if (!state.auth?.user) {
    renderAuthView();
    return;
  }
  if (state.auth.user.role === "patient") {
    await loadPatientDashboard();
    return;
  }
  if (state.auth.user.role === "doctor") {
    await loadDoctorDashboard();
    return;
  }
  if (state.auth.user.role === "family") {
    await loadFamilyDashboard();
  }
}

function syncNotifications(notifications) {
  const unreadIds = notifications.filter((item) => !item.isRead).map((item) => item.id);
  if (!state.notificationBootstrapped) {
    unreadIds.forEach((id) => state.notificationSeenIds.add(id));
    state.notificationBootstrapped = true;
    return;
  }

  notifications.forEach((item) => {
    if (!item.isRead && !state.notificationSeenIds.has(item.id)) {
      state.notificationSeenIds.add(item.id);
      showToast(item.title, item.message);
    }
  });
}

function closeRideStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function syncRideStream() {
  closeRideStream();
  if (!state.activeRide?.id || state.activeRide.status !== "active") {
    return;
  }

  const token = getStoredToken();
  if (!token) {
    return;
  }

  state.stream = new EventSource(`/api/rides/${state.activeRide.id}/stream?token=${encodeURIComponent(token)}`);
  state.stream.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.ride) {
      return;
    }

    state.activeRide = payload.ride;
    if (state.patientDashboard) {
      state.patientDashboard.activeRide = payload.ride;
    }

    if (payload.type === "ride_finished") {
      closeRideStream();
      await loadPatientDashboard();
      return;
    }

    renderPatientView();
  };
}

async function refreshNotificationsOnly() {
  if (!state.auth?.user) {
    return;
  }
  let data;
  try {
    data = await fetchJson("/api/notifications");
  } catch (error) {
    if (error.message === "Unauthorized") {
      clearAppState();
      renderAuthView();
      return;
    }
    throw error;
  }
  syncNotifications(data.notifications);
  if (state.auth.user.role === "patient" && state.patientDashboard) {
    state.patientDashboard.notifications = data.notifications;
    renderPatientView();
  }
  if (state.auth.user.role === "doctor" && state.doctorDashboard) {
    state.doctorDashboard.notifications = data.notifications;
    renderDoctorView();
  }
  if (state.auth.user.role === "family" && state.familyDashboard) {
    state.familyDashboard.notifications = data.notifications;
    renderFamilyView();
  }
}

function startNotificationPolling() {
  stopNotificationPolling();
  state.notificationPoller = setInterval(() => {
    refreshNotificationsOnly().catch(console.error);
  }, 6000);
}

function stopNotificationPolling() {
  if (state.notificationPoller) {
    clearInterval(state.notificationPoller);
    state.notificationPoller = null;
  }
}

async function bootstrap() {
  state.referenceData = await fetchJson("/api/reference-data");
  const token = getStoredToken();
  if (token) {
    try {
      const me = await fetchJson("/api/auth/me");
      setAuthContext(me.user ? me : null);
    } catch (_error) {
      storeToken(null);
      setAuthContext(null);
    }
  } else {
    setAuthContext(null);
  }
  await loadRoleView();
  if (state.auth?.user) {
    startNotificationPolling();
  }
}

document.addEventListener("change", (event) => {
  if (event.target.id === "registerRole") {
    const patientFields = document.getElementById("patientRegistrationFields");
    if (patientFields) {
      patientFields.style.display = event.target.value === "patient" ? "grid" : "none";
    }
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "loginForm") {
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      const result = await fetchJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      setAuthContext(result);
      startNotificationPolling();
      await loadRoleView();
    } catch (error) {
      window.alert(error.message);
    }
  }

  if (event.target.id === "registerForm") {
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      const role = formData.get("role");
      const payload = {
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        role,
      };
      if (role === "patient") {
        payload.templateProfileId = formData.get("templateProfileId");
        payload.age = Number(formData.get("age")) || null;
        payload.gender = formData.get("gender");
      }
      const result = await fetchJson("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setAuthContext(result);
      startNotificationPolling();
      await loadRoleView();
    } catch (error) {
      window.alert(error.message);
    }
  }

  if (event.target.id === "thresholdForm") {
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      await fetchJson(`/api/doctor/patients/${formData.get("patientId")}/threshold`, {
        method: "POST",
        body: JSON.stringify({
          adjustment: Number(formData.get("adjustment")),
        }),
      });
      await loadDoctorDashboard(formData.get("patientId"));
    } catch (error) {
      window.alert(error.message);
    }
  }

  if (event.target.id === "statusForm") {
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      await fetchJson(`/api/doctor/patients/${formData.get("patientId")}/status`, {
        method: "POST",
        body: JSON.stringify({
          status: formData.get("status"),
        }),
      });
      await loadDoctorDashboard(formData.get("patientId"));
    } catch (error) {
      window.alert(error.message);
    }
  }

  if (event.target.id === "familyLinkForm") {
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      await fetchJson("/api/family/link", {
        method: "POST",
        body: JSON.stringify({
          patientEmail: formData.get("patientEmail"),
        }),
      });
      await loadFamilyDashboard();
    } catch (error) {
      window.alert(error.message);
    }
  }
});

document.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;

  try {
    if (action === "logout") {
      await fetchJson("/api/auth/logout", { method: "POST" });
      clearAppState();
      renderAuthView();
      return;
    }

    if (action === "start-ride") {
      const scenarioSelect = document.getElementById("patientScenarioSelect");
      let startLocation = state.currentLocation;
      if (!startLocation) {
        startLocation = await locateCurrentPosition(true);
      }
      if (!startLocation) {
        return;
      }
      const result = await fetchJson("/api/patient/rides/start", {
        method: "POST",
        body: JSON.stringify({
          scenarioId: scenarioSelect.value,
          startLocation: {
            lat: startLocation.lat,
            lng: startLocation.lng,
            accuracy: startLocation.accuracy,
          },
        }),
      });
      state.activeRide = result.ride;
      await loadPatientDashboard();
      return;
    }

    if (action === "locate-me") {
      await locateCurrentPosition(true);
      return;
    }

    if (action === "finish-ride") {
      await fetchJson(`/api/patient/rides/${actionTarget.dataset.id}/finish`, { method: "POST" });
      await loadPatientDashboard();
      return;
    }

    if (action === "view-ride") {
      const ride = await fetchJson(`/api/rides/${actionTarget.dataset.id}/report`);
      state.selectedRideId = ride.ride.id;
      if (state.auth.user.role === "patient") {
        const existingIndex = state.patientDashboard.recentRides.findIndex((item) => item.id === ride.ride.id);
        if (existingIndex >= 0) {
          state.patientDashboard.recentRides[existingIndex] = ride.ride;
        }
        renderPatientView();
      } else if (state.auth.user.role === "doctor" && state.doctorPatientDetail) {
        const existingIndex = state.doctorPatientDetail.recentRides.findIndex((item) => item.id === ride.ride.id);
        if (existingIndex >= 0) {
          state.doctorPatientDetail.recentRides[existingIndex] = ride.ride;
        }
        renderDoctorView();
      }
      return;
    }

    if (action === "select-patient") {
      await loadDoctorDashboard(actionTarget.dataset.id);
      return;
    }

    if (action === "mark-notification") {
      const notifications = await fetchJson(`/api/notifications/${actionTarget.dataset.id}/read`, { method: "POST" });
      if (state.auth.user.role === "patient" && state.patientDashboard) {
        state.patientDashboard.notifications = notifications.notifications;
        renderPatientView();
      }
      if (state.auth.user.role === "doctor" && state.doctorDashboard) {
        state.doctorDashboard.notifications = notifications.notifications;
        renderDoctorView();
      }
      if (state.auth.user.role === "family" && state.familyDashboard) {
        state.familyDashboard.notifications = notifications.notifications;
        renderFamilyView();
      }
    }
  } catch (error) {
    window.alert(error.message);
  }
});

bootstrap().catch((error) => {
  console.error(error);
  window.alert("初始化失败，请检查服务端日志。");
});
