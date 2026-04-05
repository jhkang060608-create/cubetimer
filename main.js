import "scramble-display";
import { randomScrambleForEvent } from "cubing/scramble";

const scrambleText = document.getElementById("scrambleText");
const scramblePreview = document.getElementById("scramblePreview");
const prevScrambleBtn = document.getElementById("prevScrambleBtn");
const nextScrambleBtn = document.getElementById("nextScrambleBtn");
const timerDisplay = document.getElementById("timerDisplay");
const timerSection = document.querySelector(".timer");
const historyList = document.getElementById("historyList");
const sessionSelect = document.getElementById("sessionSelect");
const newSessionBtn = document.getElementById("newSessionBtn");
const renameSessionBtn = document.getElementById("renameSessionBtn");
const deleteSessionBtn = document.getElementById("deleteSessionBtn");
const resetSessionBtn = document.getElementById("resetSessionBtn");
const eventSelect = document.getElementById("eventSelect");
const statBest = document.getElementById("statBest");
const statMean = document.getElementById("statMean");
const statAo5 = document.getElementById("statAo5");
const statAo12 = document.getElementById("statAo12");
const exportBtn = document.getElementById("exportBtn");
const exportModal = document.getElementById("exportModal");
const exportText = document.getElementById("exportText");
const exportCopyBtn = document.getElementById("exportCopyBtn");
const exportCloseBtn = document.getElementById("exportCloseBtn");
const statsGrid = document.getElementById("statsGrid");
const solveModal = document.getElementById("solveModal");
const solveModalMeta = document.getElementById("solveModalMeta");
const solveModalStatus = document.getElementById("solveModalStatus");
const solveOkBtn = document.getElementById("solveOkBtn");
const solvePlus2Btn = document.getElementById("solvePlus2Btn");
const solveDnfBtn = document.getElementById("solveDnfBtn");
const solveEditBtn = document.getElementById("solveEditBtn");
const solveDeleteBtn = document.getElementById("solveDeleteBtn");
const solveCloseBtn = document.getElementById("solveCloseBtn");
const solveShareBtn = document.getElementById("solveShareBtn");
const progressChart = document.getElementById("progressChart");
const chartZoomOutBtn = document.getElementById("chartZoomOutBtn");
const chartZoomInBtn = document.getElementById("chartZoomInBtn");
const chartWindowLabel = document.getElementById("chartWindowLabel");
const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const themeSystemBtn = document.getElementById("themeSystemBtn");
const themeLightBtn = document.getElementById("themeLightBtn");
const themeDarkBtn = document.getElementById("themeDarkBtn");
const togglePreview = document.getElementById("togglePreview");
const toggleChart = document.getElementById("toggleChart");
const toggleAo5 = document.getElementById("toggleAo5");
const toggleAo12 = document.getElementById("toggleAo12");
const toggleInspection = document.getElementById("toggleInspection");
const toggleHideLive = document.getElementById("toggleHideLive");
const accentButtons = document.querySelectorAll("[data-accent]");

const STORAGE_KEY = "cubeTimerState";

let currentScramble = "";
let timerState = "idle"; // idle | holding | running | stopped
let startTime = 0;
let rafId = 0;
let holdTimeoutId = 0;
let holdReady = false;
let scrambleRequestId = 0;
let activeSolveId = null;
let chartWindowSize = 30;
let inspectionActive = false;
let inspectionStartTime = 0;
let inspectionRafId = 0;
let nextSolvePenalty = "OK";
let inspectionSpoken8 = false;
let inspectionSpoken12 = false;
let hideLiveUpdates = false;
let scrambleHistory = [];
let scrambleIndex = -1;
let inputLock = false;
const THEME_KEY = "cubeTimerTheme";
const ACCENT_KEY = "cubeTimerAccent";
const PREVIEW_KEY = "cubeTimerShowPreview";
const CHART_KEY = "cubeTimerShowChart";
const CHART_USER_KEY = "cubeTimerChartUserSet";
const INSPECTION_KEY = "cubeTimerInspection";
const HIDE_LIVE_KEY = "cubeTimerHideLiveTime";
const AO5_KEY = "cubeTimerShowAo5";
const AO12_KEY = "cubeTimerShowAo12";

const ACCENT_THEMES = {
  ocean: {
    light: { accent: "#1f6fe5", accent2: "#2c6b5a", swatch: "#1f6fe5" },
    dark: { accent: "#4c8dff", accent2: "#45c2a3", swatch: "#4c8dff" },
  },
  mint: {
    light: { accent: "#1f9d7a", accent2: "#3f6be2", swatch: "#1f9d7a" },
    dark: { accent: "#35c8a3", accent2: "#6b8dff", swatch: "#35c8a3" },
  },
  amber: {
    light: { accent: "#e28a1f", accent2: "#2c6bff", swatch: "#e28a1f" },
    dark: { accent: "#ffb14a", accent2: "#5a8cff", swatch: "#ffb14a" },
  },
  berry: {
    light: { accent: "#c43b7b", accent2: "#3b7cc4", swatch: "#c43b7b" },
    dark: { accent: "#ff77b5", accent2: "#6aa8ff", swatch: "#ff77b5" },
  },
  coral: {
    light: { accent: "#ff6b6b", accent2: "#3b7cc4", swatch: "#ff6b6b" },
    dark: { accent: "#ff8f8f", accent2: "#6aa8ff", swatch: "#ff8f8f" },
  },
  teal: {
    light: { accent: "#1a9d8f", accent2: "#3f6be2", swatch: "#1a9d8f" },
    dark: { accent: "#35c9ba", accent2: "#6b8dff", swatch: "#35c9ba" },
  },
  violet: {
    light: { accent: "#7b5cff", accent2: "#ff8ab5", swatch: "#7b5cff" },
    dark: { accent: "#a08bff", accent2: "#ff9ec2", swatch: "#a08bff" },
  },
  slate: {
    light: { accent: "#4b5563", accent2: "#7c3aed", swatch: "#4b5563" },
    dark: { accent: "#9aa4b2", accent2: "#b893ff", swatch: "#9aa4b2" },
  },
  lime: {
    light: { accent: "#7cb518", accent2: "#1f6fe5", swatch: "#7cb518" },
    dark: { accent: "#a7e235", accent2: "#5a8cff", swatch: "#a7e235" },
  },
};

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const defaultState = () => {
  const session = createSession("세션 1");
  return {
    sessions: [session],
    activeSessionId: session.id,
    settings: {
      eventId: "333",
    },
  };
};

let appState = loadState();

function createSession(name) {
  return {
    id: generateId(),
    name,
    solves: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed.sessions || !parsed.sessions.length) {
      return defaultState();
    }
    if (!parsed.settings) {
      parsed.settings = { eventId: "333" };
    }
    if (!parsed.settings.eventId) parsed.settings.eventId = "333";
    if (!parsed.activeSessionId) parsed.activeSessionId = parsed.sessions[0].id;
    return parsed;
  } catch (error) {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function activeSession() {
  return appState.sessions.find((s) => s.id === appState.activeSessionId);
}

function formatTime(ms) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return totalSeconds.toFixed(2);
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

function formatSolveTime(solve) {
  if (solve.penalty === "DNF") return "DNF";
  const adjusted = solve.timeMs + (solve.penalty === "PLUS2" ? 2000 : 0);
  return solve.penalty === "PLUS2" ? `${formatTime(adjusted)} (+2)` : formatTime(adjusted);
}

const EVENT_LABELS = {
  "222": "2x2x2",
  "333": "3x3x3",
  "444": "4x4x4",
  "555": "5x5x5",
  "666": "6x6x6",
  "777": "7x7x7",
  "333oh": "3x3x3 OH",
  "333bf": "3x3x3 BF",
  "333fm": "3x3x3 FMC",
  "333mbf": "3x3x3 MBLD",
  "clock": "Clock",
  "minx": "Megaminx",
  "pyram": "Pyraminx",
  "skewb": "Skewb",
  "sq1": "Square-1",
  "444bf": "4x4x4 BF",
  "555bf": "5x5x5 BF",
};

function eventLabel(eventId) {
  return EVENT_LABELS[eventId] || eventId;
}

function adjustedTimeMs(solve) {
  if (solve.penalty === "DNF") return Infinity;
  return solve.timeMs + (solve.penalty === "PLUS2" ? 2000 : 0);
}

function parseTimeInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 2) return null;
  let seconds = 0;
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const sec = Number(parts[1]);
    if (Number.isNaN(minutes) || Number.isNaN(sec)) return null;
    seconds = minutes * 60 + sec;
  } else {
    const sec = Number(parts[0]);
    if (Number.isNaN(sec)) return null;
    seconds = sec;
  }
  if (seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function setDisplay(ms) {
  timerDisplay.textContent = formatTime(ms);
}

function setSolvingDisplay() {
  timerDisplay.textContent = "Solving";
}


function resetInspection() {
  inspectionActive = false;
  inspectionStartTime = 0;
  inspectionSpoken8 = false;
  inspectionSpoken12 = false;
  if (inspectionRafId) {
    cancelAnimationFrame(inspectionRafId);
    inspectionRafId = 0;
  }
  timerDisplay.classList.remove("inspect-warn", "inspect-danger");
}

function speakInspection(seconds) {
  if (!("speechSynthesis" in window)) return;
  const utter = new SpeechSynthesisUtterance(`${seconds} seconds`);
  utter.lang = "en-US";
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
}

function inspectionTick() {
  if (!inspectionActive) return;
  const elapsed = (performance.now() - inspectionStartTime) / 1000;
  const remaining = 15 - elapsed;
  if (elapsed > 17) {
    timerDisplay.textContent = "DNF";
  } else if (elapsed > 15) {
    timerDisplay.textContent = "+2";
  } else {
    timerDisplay.textContent = Math.ceil(Math.max(0, remaining)).toString();
  }
  if (!inspectionSpoken8 && elapsed >= 8) {
    inspectionSpoken8 = true;
    speakInspection(8);
  }
  if (!inspectionSpoken12 && elapsed >= 12) {
    inspectionSpoken12 = true;
    speakInspection(12);
  }
  if (remaining <= 0) {
    timerDisplay.classList.add("inspect-danger");
    timerDisplay.classList.remove("inspect-warn");
  } else if (remaining <= 3) {
    timerDisplay.classList.add("inspect-warn");
    timerDisplay.classList.remove("inspect-danger");
  } else {
    timerDisplay.classList.remove("inspect-warn", "inspect-danger");
  }
  inspectionRafId = requestAnimationFrame(inspectionTick);
}

function startInspection() {
  if (inspectionActive) return;
  inspectionActive = true;
  inspectionStartTime = performance.now();
  inspectionTick();
}

function clearHoldState() {
  clearTimeout(holdTimeoutId);
  holdTimeoutId = 0;
  holdReady = false;
  timerDisplay.classList.remove("hold", "ready");
}

function tick() {
  if (timerState !== "running") return;
  const now = performance.now();
  if (!hideLiveUpdates) {
    setDisplay(now - startTime);
  }
  rafId = requestAnimationFrame(tick);
}

function startTimer() {
  timerState = "running";
  clearHoldState();
  startTime = performance.now();
  if (hideLiveUpdates) {
    setSolvingDisplay();
  }
  rafId = requestAnimationFrame(tick);
}

function stopTimer() {
  timerState = "stopped";
  cancelAnimationFrame(rafId);
  const finalTime = performance.now() - startTime;
  setDisplay(finalTime);
  pushSolve(finalTime, nextSolvePenalty);
  nextSolvePenalty = "OK";
  // 입력이 눌린 상태면 바로 다음 솔브가 시작되지 않도록 잠금.
  inputLock = true;
  void generateScramble();
}

function resetTimer() {
  timerState = "idle";
  cancelAnimationFrame(rafId);
  clearHoldState();
  resetInspection();
  setDisplay(0);
  inputLock = false;
}

function pushSolve(ms, penalty = "OK") {
  const session = activeSession();
  if (!session) return;
  session.solves.unshift({
    id: generateId(),
    timeMs: ms,
    scramble: currentScramble,
    penalty,
    createdAt: Date.now(),
    eventId: appState.settings.eventId,
  });
  saveState();
  renderAll();
}

function beginHold() {
  if (timerState === "running") return;
  // 이전 입력이 해제될 때까지 홀드 시작을 막음.
  if (inputLock) return;
  timerState = "holding";
  holdReady = false;
  if (inspectionActive) {
    if (inspectionRafId) {
      cancelAnimationFrame(inspectionRafId);
      inspectionRafId = 0;
    }
    timerDisplay.classList.remove("inspect-warn", "inspect-danger");
  }
  timerDisplay.classList.add("hold");
  holdTimeoutId = window.setTimeout(() => {
    holdReady = true;
    timerDisplay.classList.remove("hold");
    timerDisplay.classList.add("ready");
  }, 300);
}

function endHold() {
  if (timerState !== "holding") return;
  if (holdReady) {
    if (inspectionActive) {
      const elapsed = (performance.now() - inspectionStartTime) / 1000;
      if (elapsed > 17) {
        nextSolvePenalty = "DNF";
      } else if (elapsed > 15) {
        nextSolvePenalty = "PLUS2";
      } else {
        nextSolvePenalty = "OK";
      }
      resetInspection();
    }
    startTimer();
  } else {
    timerState = "idle";
    clearHoldState();
  }
}

function renderSessions() {
  sessionSelect.innerHTML = "";
  appState.sessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = session.name;
    if (session.id === appState.activeSessionId) option.selected = true;
    sessionSelect.append(option);
  });
}

function renderHistory() {
  const session = activeSession();
  historyList.innerHTML = "";
  if (!session) return;

  session.solves.forEach((solve, index) => {
    const li = document.createElement("li");
    li.className = "solve-item";
    li.dataset.index = String(index);

    const rowTop = document.createElement("div");
    rowTop.className = "solve-cards";

    const cardTime = document.createElement("div");
    cardTime.className = "solve-card";
    cardTime.innerHTML = `<div class="card-label">Time</div><div class="card-value">${formatSolveTime(solve)}</div>`;

    const cardEvent = document.createElement("div");
    cardEvent.className = "solve-card";
    cardEvent.innerHTML = `<div class="card-label">Event</div><div class="card-value">${eventLabel(solve.eventId)}</div>`;

    const cardAo5 = document.createElement("div");
    cardAo5.className = "solve-card";
    cardAo5.dataset.share = "ao5";
    cardAo5.innerHTML = `<div class="card-label">ao5</div><div class="card-value">${formatAverageAtIndex(session.solves, index, 5)}</div>`;

    const cardAo12 = document.createElement("div");
    cardAo12.className = "solve-card";
    cardAo12.dataset.share = "ao12";
    cardAo12.innerHTML = `<div class="card-label">ao12</div><div class="card-value">${formatAverageAtIndex(session.solves, index, 12)}</div>`;

    rowTop.append(cardTime, cardEvent, cardAo5, cardAo12);

    li.dataset.id = solve.id;
    li.append(rowTop);
    historyList.append(li);
  });
}

function exportSession() {
  const session = activeSession();
  if (!session) return;
  const stamp = formatShareTimestampDashed(new Date());
  const header = `Genrated by  CubeTimer in ${stamp}`;
  const currentAo5 = formatAverageValue(averageWindowValue(session.solves, 5));
  const bestAo5 = formatAverageValue(bestAverageValue(session.solves, 5));
  const currentAo12 = formatAverageValue(averageWindowValue(session.solves, 12));
  const bestAo12 = formatAverageValue(bestAverageValue(session.solves, 12));
  const stats = [
    `Current Ao5: ${currentAo5}`,
    `Best Ao5: ${bestAo5}`,
    `Current Ao12: ${currentAo12}`,
    `Best Ao12: ${bestAo12}`,
  ].join("\n");
  const lines = session.solves.map((solve, index) => {
    return `${index + 1}. ${formatSolveTime(solve)} ${solve.scramble}`;
  });
  openExportModal("기록 내보내기", `${header}\n\n${stats}\n\n${lines.join("\n")}`.trim());
}

function renderStats() {
  const session = activeSession();
  if (!session || session.solves.length === 0) {
    statBest.textContent = "-";
    statMean.textContent = "-";
    statAo5.textContent = "-";
    statAo12.textContent = "-";
    return;
  }

  const validTimes = session.solves
    .filter((s) => s.penalty !== "DNF")
    .map((s) => s.timeMs + (s.penalty === "PLUS2" ? 2000 : 0));

  statBest.textContent = validTimes.length ? formatTime(Math.min(...validTimes)) : "-";
  statMean.textContent = validTimes.length
    ? formatTime(validTimes.reduce((a, b) => a + b, 0) / validTimes.length)
    : "-";

  statAo5.textContent = formatAverageOf(session.solves, 5);
  statAo12.textContent = formatAverageOf(session.solves, 12);
}

function formatAverageOf(solves, count) {
  if (solves.length < count) return "-";
  const window = solves.slice(0, count);
  const values = window.map((s) => {
    if (s.penalty === "DNF") return Infinity;
    return s.timeMs + (s.penalty === "PLUS2" ? 2000 : 0);
  });
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  if (trimmed.some((v) => !Number.isFinite(v))) return "DNF";
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return formatTime(avg);
}

function formatAverageAtIndex(solves, index, count) {
  if (solves.length < index + count) return "-";
  const window = solves.slice(index, index + count);
  const values = window.map((s) => adjustedTimeMs(s));
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  if (trimmed.some((v) => !Number.isFinite(v))) return "DNF";
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return formatTime(avg);
}

function windowSolvesAtIndex(solves, index, count) {
  if (solves.length < index + count) return [];
  return solves.slice(index, index + count);
}

function averageAtIndexChrono(solves, index, count) {
  if (index < count - 1) return null;
  const windowSolves = solves.slice(index - (count - 1), index + 1);
  const values = windowSolves.map((s) => s.time);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  if (!trimmed.length) return null;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function renderChart() {
  if (!progressChart) return;
  const session = activeSession();
  const ctx = progressChart.getContext("2d");
  if (!ctx || !session) return;

  const rect = progressChart.getBoundingClientRect();
  const width = rect.width || progressChart.clientWidth || 480;
  const height = rect.height || progressChart.clientHeight || 240;
  const ratio = window.devicePixelRatio || 1;
  progressChart.width = Math.floor(width * ratio);
  progressChart.height = Math.floor(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.body);
  const accent = styles.getPropertyValue("--accent").trim() || "#1f6fe5";
  const accent2 = styles.getPropertyValue("--accent-2").trim() || "#2c6b5a";
  const chartBg = styles.getPropertyValue("--chart-bg").trim() || "#fffaf3";
  const chartGrid = styles.getPropertyValue("--chart-grid").trim() || "rgba(30, 27, 22, 0.08)";
  const showAo5 = localStorage.getItem(AO5_KEY) !== "false";
  const showAo12 = localStorage.getItem(AO12_KEY) !== "false";
  ctx.fillStyle = chartBg;
  ctx.fillRect(0, 0, width, height);

  const allSolves = session.solves
    .filter((s) => s.penalty !== "DNF")
    .map((s) => ({
      time: s.timeMs + (s.penalty === "PLUS2" ? 2000 : 0),
      createdAt: s.createdAt,
    }))
    .slice()
    .reverse();

  const total = allSolves.length;
  if (total > 0) {
    chartWindowSize = Math.min(Math.max(1, chartWindowSize), total);
  }
  const windowSize = Math.min(chartWindowSize, total);
  const solves = allSolves.slice(-windowSize);
  const windowStartIndex = Math.max(0, total - windowSize);

  if (chartWindowLabel) {
    chartWindowLabel.textContent = total === 0 ? "-" : `${windowSize}개`;
  }

  if (solves.length === 0) {
    ctx.fillStyle = "#6a5f54";
    ctx.font = "14px Space Grotesk, Noto Sans KR, sans-serif";
    ctx.fillText("데이터 없음", 12, 24);
    return;
  }

  const times = solves.map((s) => s.time);
  const ao5Values = showAo5
    ? solves.map((_, idx) => averageAtIndexChrono(allSolves, windowStartIndex + idx, 5))
    : [];
  const ao12Values = showAo12
    ? solves.map((_, idx) => averageAtIndexChrono(allSolves, windowStartIndex + idx, 12))
    : [];
  const min = Math.min(...times);
  const max = Math.max(...times);
  const extraValues = [...ao5Values, ...ao12Values].filter((v) => Number.isFinite(v));
  const extendedMin = Math.min(min, ...(extraValues.length ? extraValues : [min]));
  const extendedMax = Math.max(max, ...(extraValues.length ? extraValues : [max]));
  const padding = Math.max(1, (extendedMax - extendedMin) * 0.15);
  const yMin = Math.max(0, extendedMin - padding);
  const yMax = extendedMax + padding;

  const chartPadding = { top: 12, right: 12, bottom: 20, left: 36 };
  const innerWidth = width - chartPadding.left - chartPadding.right;
  const innerHeight = height - chartPadding.top - chartPadding.bottom;

  ctx.strokeStyle = chartGrid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartPadding.left, chartPadding.top);
  ctx.lineTo(chartPadding.left, height - chartPadding.bottom);
  ctx.lineTo(width - chartPadding.right, height - chartPadding.bottom);
  ctx.stroke();

  const yScale = (value) =>
    chartPadding.top + (1 - (value - yMin) / (yMax - yMin || 1)) * innerHeight;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  solves.forEach((solve, index) => {
    const x = chartPadding.left + (innerWidth * index) / Math.max(1, solves.length - 1);
    const y = yScale(solve.time);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const drawSeries = (values, style, dash = []) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        started = false;
        return;
      }
      const x = chartPadding.left + (innerWidth * index) / Math.max(1, values.length - 1);
      const y = yScale(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  ctx.fillStyle = accent2;
  solves.forEach((solve, index) => {
    const x = chartPadding.left + (innerWidth * index) / Math.max(1, solves.length - 1);
    const y = yScale(solve.time);
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  if (showAo5) {
    drawSeries(ao5Values, accent2);
  }
  if (showAo12) {
    drawSeries(ao12Values, "#6f7a8a", [6, 6]);
  }

  ctx.fillStyle = "#6a5f54";
  ctx.font = "12px Space Grotesk, Noto Sans KR, sans-serif";
  ctx.fillText(formatTime(yMin), 6, height - chartPadding.bottom + 14);
  ctx.fillText(formatTime(yMax), 6, chartPadding.top + 10);
}

function adjustChartWindow(delta) {
  const session = activeSession();
  if (!session) return;
  const total = session.solves.filter((s) => s.penalty !== "DNF").length;
  if (total === 0) return;
  chartWindowSize = Math.min(Math.max(1, chartWindowSize + delta), total);
  renderChart();
}

function openExportModal(title, text) {
  exportText.value = text;
  exportModal.classList.add("open");
  exportModal.setAttribute("aria-hidden", "false");
  const heading = exportModal.querySelector("h2");
  if (heading) heading.textContent = title;
}

function openSettingsModal() {
  settingsModal.classList.add("open");
  settingsModal.setAttribute("aria-hidden", "false");
}

function closeSettingsModal() {
  settingsModal.classList.remove("open");
  settingsModal.setAttribute("aria-hidden", "true");
}

function setTheme(theme) {
  let resolved = theme;
  if (theme === "system") {
    resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (resolved === "dark") {
    document.body.classList.add("theme-dark");
    themeDarkBtn.classList.add("secondary");
    themeLightBtn.classList.remove("secondary");
  } else {
    document.body.classList.remove("theme-dark");
    themeLightBtn.classList.add("secondary");
    themeDarkBtn.classList.remove("secondary");
  }
  themeSystemBtn.classList.toggle("secondary", theme === "system");
  localStorage.setItem(THEME_KEY, theme);
  const savedAccent = localStorage.getItem(ACCENT_KEY) || "ocean";
  setAccentTheme(savedAccent);
  updateAccentSwatches();
  renderChart();
}

function setAccentTheme(name) {
  const themeGroup = ACCENT_THEMES[name] || ACCENT_THEMES.ocean;
  const mode = document.body.classList.contains("theme-dark") ? "dark" : "light";
  const theme = themeGroup[mode];
  document.body.setAttribute("data-accent", name);
  document.documentElement.style.setProperty("--accent", theme.accent);
  document.documentElement.style.setProperty("--accent-2", theme.accent2);
  document.body.style.setProperty("--accent", theme.accent);
  document.body.style.setProperty("--accent-2", theme.accent2);
  accentButtons.forEach((btn) => {
    const key = btn.getAttribute("data-accent");
    btn.classList.toggle("active", key === name);
  });
  localStorage.setItem(ACCENT_KEY, name);
  renderChart();
}

function applyVisibilitySettings() {
  const showPreview = localStorage.getItem(PREVIEW_KEY);
  const showChart = localStorage.getItem(CHART_KEY);
  const previewVisible = showPreview !== "false";
  const chartVisible = showChart !== "false";
  const previewEl = document.querySelector(".preview-side");
  const chartEl = document.querySelector(".chart-card");
  const visualRow = document.querySelector(".visual-row");
  if (previewEl) previewEl.style.display = previewVisible ? "" : "none";
  if (chartEl) chartEl.style.display = chartVisible ? "" : "none";
  if (togglePreview) togglePreview.checked = previewVisible;
  if (toggleChart) toggleChart.checked = chartVisible;
  document.body.classList.toggle("hide-preview", !previewVisible);
  document.body.classList.toggle("hide-chart", !chartVisible);
  if (visualRow) {
    visualRow.style.display = previewVisible || chartVisible ? "" : "none";
  }
  requestAnimationFrame(() => {
    renderChart();
  });
}

function formatShareTimestamp(date) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function formatShareTimestampDashed(date) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
}

function averageWindowValue(solves, count) {
  if (solves.length < count) return null;
  const windowSolves = solves.slice(0, count);
  const values = windowSolves.map((s) => adjustedTimeMs(s));
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  if (trimmed.some((v) => !Number.isFinite(v))) return "DNF";
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return avg;
}

function bestAverageValue(solves, count) {
  if (solves.length < count) return null;
  let best = Infinity;
  let hasWindow = false;
  let hasValid = false;
  for (let i = 0; i <= solves.length - count; i += 1) {
    const windowSolves = solves.slice(i, i + count);
    const values = windowSolves.map((s) => adjustedTimeMs(s));
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, sorted.length - 1);
    hasWindow = true;
    if (trimmed.some((v) => !Number.isFinite(v))) {
      continue;
    }
    hasValid = true;
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    if (avg < best) best = avg;
  }
  if (!hasWindow) return null;
  if (!hasValid) return "DNF";
  return best;
}

function formatAverageValue(value) {
  if (value === null) return "-";
  if (value === "DNF") return "DNF";
  return formatTime(value);
}

function buildSolveLines(solves) {
  return solves.map((solve, index) => {
    const time = formatSolveTime(solve);
    const created = new Date(solve.createdAt).toISOString();
    return `${index + 1}\t${time}\t${solve.penalty}\t${solve.eventId}\t${solve.scramble}\t${created}`;
  });
}

function exportStat(type) {
  const session = activeSession();
  if (!session) return;
  const header = `Genrated by  CubeTimer in ${formatShareTimestamp(new Date())}`;
  const solves = session.solves;

  if (type === "best") {
    const candidates = solves.filter((s) => s.penalty !== "DNF");
    if (!candidates.length) {
      openExportModal("Best", `${header}\nNo valid solves.`);
      return;
    }
    const bestSolve = candidates.reduce((best, cur) =>
      adjustedTimeMs(cur) < adjustedTimeMs(best) ? cur : best,
    );
    const lines = [`1. ${formatSolveTime(bestSolve)} ${bestSolve.scramble}`];
    openExportModal("Best", `${header}\n\n${lines.join("\n")}`);
    return;
  }

  if (type === "mean") {
    const valid = solves.filter((s) => s.penalty !== "DNF");
    if (!valid.length) {
      openExportModal("평균", `${header}\nNo valid solves.`);
      return;
    }
    const mean =
      valid.reduce((sum, s) => sum + adjustedTimeMs(s), 0) / valid.length;
    const currentAo5 = formatAverageValue(averageWindowValue(solves, 5));
    const bestAo5 = formatAverageValue(bestAverageValue(solves, 5));
    const currentAo12 = formatAverageValue(averageWindowValue(solves, 12));
    const bestAo12 = formatAverageValue(bestAverageValue(solves, 12));
    const stats = [
      `Current Ao5: ${currentAo5}`,
      `Best Ao5: ${bestAo5}`,
      `Current Ao12: ${currentAo12}`,
      `Best Ao12: ${bestAo12}`,
    ].join("\n");
    const lines = valid.map(
      (solve, index) => `${index + 1}. ${formatSolveTime(solve)} ${solve.scramble}`,
    );
    openExportModal("평균", `${header}\n\n${stats}\n\n${lines.join("\n")}`);
    return;
  }

  if (type === "ao5" || type === "ao12") {
    const count = type === "ao5" ? 5 : 12;
    if (solves.length < count) {
      openExportModal(type, `${header}\nNot enough solves (${solves.length}/${count}).`);
      return;
    }
    const windowSolves = solves.slice(0, count);
    const values = windowSolves.map((s) => adjustedTimeMs(s));
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, sorted.length - 1);
    const isDnf = trimmed.some((v) => !Number.isFinite(v));
    const avg = isDnf
      ? "DNF"
      : formatTime(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
    const lines = windowSolves.map(
      (solve, index) => `${index + 1}. ${formatSolveTime(solve)} ${solve.scramble}`,
    );
    openExportModal(type, `${header}\n\n${lines.join("\n")}`);
  }
}

function renderAll() {
  renderSessions();
  renderHistory();
  renderStats();
  renderChart();
}

async function generateScramble() {
  const eventId = appState.settings.eventId;
  let scramble = null;
  const requestId = ++scrambleRequestId;
  scrambleText.textContent = "스크램블 생성중...";

  try {
    const generated = await randomScrambleForEvent(eventId);
    scramble = generated.toString();
  } catch (error) {
    console.error("스크램블 생성 실패", error);
    try {
      const fallback = await randomScrambleForEvent("333");
      scramble = fallback.toString();
      appState.settings.eventId = "333";
      eventSelect.value = "333";
    } catch (fallbackError) {
      console.error("스크램블 폴백 실패", fallbackError);
    }
  }

  if (requestId !== scrambleRequestId) return;
  if (!scramble) {
    currentScramble = "";
    scrambleText.textContent = "스크램블 생성 실패";
    updateScrambleNav();
    return;
  }
  setCurrentScramble(scramble, appState.settings.eventId, { pushHistory: true });
}

function setCurrentScramble(scramble, eventId, options = {}) {
  const { pushHistory = false } = options;
  currentScramble = scramble;
  scrambleText.textContent = currentScramble;
  scramblePreview.setAttribute("visualization", "2D");
  scramblePreview.setAttribute("event", eventId);
  scramblePreview.setAttribute("scramble", currentScramble);
  if (pushHistory) {
    if (scrambleIndex < scrambleHistory.length - 1) {
      scrambleHistory = scrambleHistory.slice(0, scrambleIndex + 1);
    }
    scrambleHistory.push({ scramble, eventId });
    scrambleIndex = scrambleHistory.length - 1;
  }
  updateScrambleNav();
}

function updateScrambleNav() {
  if (prevScrambleBtn) {
    prevScrambleBtn.disabled = scrambleIndex <= 0;
  }
  if (nextScrambleBtn) {
    nextScrambleBtn.disabled = scrambleIndex === -1;
  }
}

prevScrambleBtn?.addEventListener("click", () => {
  if (scrambleIndex <= 0) return;
  scrambleIndex -= 1;
  const entry = scrambleHistory[scrambleIndex];
  if (entry) {
    appState.settings.eventId = entry.eventId;
    eventSelect.value = entry.eventId;
    setCurrentScramble(entry.scramble, entry.eventId, { pushHistory: false });
    resetTimer();
  }
});

nextScrambleBtn?.addEventListener("click", async () => {
  if (scrambleIndex < scrambleHistory.length - 1) {
    scrambleIndex += 1;
    const entry = scrambleHistory[scrambleIndex];
    if (entry) {
      appState.settings.eventId = entry.eventId;
      eventSelect.value = entry.eventId;
      setCurrentScramble(entry.scramble, entry.eventId, { pushHistory: false });
      resetTimer();
    }
    return;
  }
  await generateScramble();
  resetTimer();
});

sessionSelect.addEventListener("change", () => {
  appState.activeSessionId = sessionSelect.value;
  saveState();
  renderAll();
});

newSessionBtn.addEventListener("click", () => {
  const name = window.prompt("새 세션 이름", `세션 ${appState.sessions.length + 1}`);
  if (!name) return;
  const session = createSession(name);
  appState.sessions.unshift(session);
  appState.activeSessionId = session.id;
  saveState();
  renderAll();
});

renameSessionBtn.addEventListener("click", () => {
  const session = activeSession();
  if (!session) return;
  const name = window.prompt("세션 이름 변경", session.name);
  if (!name) return;
  session.name = name;
  saveState();
  renderAll();
});

deleteSessionBtn.addEventListener("click", () => {
  if (appState.sessions.length <= 1) {
    window.alert("최소 1개의 세션이 필요합니다.");
    return;
  }
  const session = activeSession();
  if (!session) return;
  const confirmed = window.confirm("현재 세션을 삭제할까요?");
  if (!confirmed) return;
  appState.sessions = appState.sessions.filter((s) => s.id !== session.id);
  appState.activeSessionId = appState.sessions[0].id;
  saveState();
  renderAll();
});

resetSessionBtn.addEventListener("click", () => {
  const session = activeSession();
  if (!session) return;
  const confirmed = window.confirm("현재 세션 기록을 모두 삭제할까요?");
  if (!confirmed) return;
  session.solves = [];
  saveState();
  renderAll();
});

exportBtn.addEventListener("click", () => {
  exportSession();
});

statsGrid.addEventListener("click", (event) => {
  const target = event.target.closest(".stat");
  if (!target) return;
  const type = target.dataset.export;
  if (!type) return;
  exportStat(type);
});

exportCopyBtn.addEventListener("click", async () => {
  exportText.select();
  exportText.setSelectionRange(0, exportText.value.length);
  try {
    await navigator.clipboard.writeText(exportText.value);
  } catch (error) {
    document.execCommand("copy");
  }
});

exportCloseBtn.addEventListener("click", () => {
  exportModal.classList.remove("open");
  exportModal.setAttribute("aria-hidden", "true");
});

exportModal.addEventListener("click", (event) => {
  if (event.target === exportModal) {
    exportModal.classList.remove("open");
    exportModal.setAttribute("aria-hidden", "true");
  }
});

function closeExportModal() {
  exportModal.classList.remove("open");
  exportModal.setAttribute("aria-hidden", "true");
}

settingsBtn.addEventListener("click", openSettingsModal);
settingsCloseBtn.addEventListener("click", closeSettingsModal);
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettingsModal();
});
themeSystemBtn.addEventListener("click", () => setTheme("system"));
themeLightBtn.addEventListener("click", () => setTheme("light"));
themeDarkBtn.addEventListener("click", () => setTheme("dark"));
togglePreview.addEventListener("change", () => {
  localStorage.setItem(PREVIEW_KEY, togglePreview.checked ? "true" : "false");
  applyVisibilitySettings();
});
toggleChart.addEventListener("change", () => {
  localStorage.setItem(CHART_KEY, toggleChart.checked ? "true" : "false");
  localStorage.setItem(CHART_USER_KEY, "true");
  applyVisibilitySettings();
});
toggleAo5?.addEventListener("change", () => {
  localStorage.setItem(AO5_KEY, toggleAo5.checked ? "true" : "false");
  renderChart();
});
toggleAo12?.addEventListener("change", () => {
  localStorage.setItem(AO12_KEY, toggleAo12.checked ? "true" : "false");
  renderChart();
});
toggleInspection.addEventListener("change", () => {
  localStorage.setItem(INSPECTION_KEY, toggleInspection.checked ? "true" : "false");
});
toggleHideLive?.addEventListener("change", () => {
  localStorage.setItem(HIDE_LIVE_KEY, toggleHideLive.checked ? "true" : "false");
  hideLiveUpdates = toggleHideLive.checked;
});
function updateAccentSwatches() {
  const mode = document.body.classList.contains("theme-dark") ? "dark" : "light";
  accentButtons.forEach((button) => {
    const name = button.getAttribute("data-accent");
    const themeGroup = ACCENT_THEMES[name] || ACCENT_THEMES.ocean;
    button.style.setProperty("--swatch", themeGroup[mode].swatch);
  });
}

accentButtons.forEach((button) => {
  const name = button.getAttribute("data-accent");
  button.addEventListener("click", () => setAccentTheme(name));
});

eventSelect.addEventListener("change", async () => {
  appState.settings.eventId = eventSelect.value;
  scrambleHistory = [];
  scrambleIndex = -1;
  saveState();
  await generateScramble();
  resetTimer();
});

function closeSolveModal() {
  solveModal.classList.remove("open");
  solveModal.setAttribute("aria-hidden", "true");
  activeSolveId = null;
}

function openSolveModal(solve) {
  activeSolveId = solve.id;
  solveModalMeta.textContent = `${formatSolveTime(solve)} | ${eventLabel(solve.eventId)} | ${solve.scramble}`;
  solveModalStatus.textContent = "";
  solveModal.classList.add("open");
  solveModal.setAttribute("aria-hidden", "false");
}

historyList.addEventListener("click", (event) => {
  const shareCard = event.target.closest(".solve-card[data-share]");
  if (shareCard) {
    const item = event.target.closest(".solve-item");
    if (!item) return;
    const index = Number(item.dataset.index);
    if (Number.isNaN(index)) return;
    const type = shareCard.dataset.share;
    const session = activeSession();
    if (!session) return;
    const count = type === "ao12" ? 12 : 5;
    const value = formatAverageAtIndex(session.solves, index, count);
    if (value === "-") {
      openExportModal(type, `Genrated by  CubeTimer in ${formatShareTimestamp(new Date())}\n\nNot enough solves.`);
      return;
    }
    const windowSolves = windowSolvesAtIndex(session.solves, index, count);
    const header = `Genrated by  CubeTimer in ${formatShareTimestamp(new Date())}`;
    const title = type === "ao12" ? "Ao12" : "Ao5";
    const lines = windowSolves.map(
      (solve, idx) => `${idx + 1}. ${formatSolveTime(solve)} ${solve.scramble}`,
    );
    openExportModal(
      title,
      `${header}\n\n${title}: ${value}\n\n${lines.join("\n")}`,
    );
    return;
  }

  const item = event.target.closest(".solve-item");
  if (!item) return;
  const id = item.dataset.id;
  if (!id) return;
  const session = activeSession();
  if (!session) return;
  const solve = session.solves.find((s) => s.id === id);
  if (!solve) return;
  openSolveModal(solve);
});

function applySolveAction(action) {
  const session = activeSession();
  if (!session || !activeSolveId) return;
  const solve = session.solves.find((s) => s.id === activeSolveId);
  if (!solve) return;

  if (action === "ok") solve.penalty = "OK";
  if (action === "plus2") solve.penalty = "PLUS2";
  if (action === "dnf") solve.penalty = "DNF";
  if (action === "edit") {
    const input = window.prompt("새 기록 (예: 12.34 or 1:02.50)", formatTime(solve.timeMs));
    if (input) {
      const ms = parseTimeInput(input);
      if (ms !== null) solve.timeMs = ms;
    }
  }
  if (action === "delete") {
    const confirmed = window.confirm("기록을 삭제할까요?");
    if (confirmed) {
      session.solves = session.solves.filter((s) => s.id !== activeSolveId);
    } else {
      return;
    }
  }

  saveState();
  renderAll();
  closeSolveModal();
}

solveOkBtn.addEventListener("click", () => applySolveAction("ok"));
solvePlus2Btn.addEventListener("click", () => applySolveAction("plus2"));
solveDnfBtn.addEventListener("click", () => applySolveAction("dnf"));
solveEditBtn.addEventListener("click", () => applySolveAction("edit"));
solveDeleteBtn.addEventListener("click", () => applySolveAction("delete"));
solveCloseBtn.addEventListener("click", closeSolveModal);

solveShareBtn.addEventListener("click", async () => {
  const session = activeSession();
  if (!session || !activeSolveId) return;
  const solve = session.solves.find((s) => s.id === activeSolveId);
  if (!solve) return;
  const stamp = formatShareTimestamp(new Date());
  const header = `Genrated by  CubeTimer in ${stamp}`;
  const line = `1. ${formatSolveTime(solve)} ${solve.scramble}`;
  openExportModal("기록 공유", `${header}\n\n${line}`);
  closeSolveModal();
});

solveModal.addEventListener("click", (event) => {
  if (event.target === solveModal) closeSolveModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeExportModal();
  closeSolveModal();
  closeSettingsModal();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (event.repeat) return;
    if (inputLock) return;
    if (timerState === "running") {
      stopTimer();
      return;
    }
    if ((timerState === "idle" || timerState === "stopped") && !inspectionActive) {
      if (toggleInspection.checked) {
        startInspection();
        timerState = "inspecting";
        return;
      }
    }
    if (timerState === "idle" || timerState === "stopped" || timerState === "inspecting") {
      beginHold();
    }
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    // 키를 떼면 잠금을 해제해서 다음 솔브를 시작할 수 있게 함.
    if (inputLock) {
      inputLock = false;
    }
    endHold();
  }
});

function attachTimerPointerControls() {
  let pointerActive = false;
  const target = timerSection || timerDisplay;
  if (!target) return;

  const onDown = (event) => {
    event.preventDefault();
    if (pointerActive) return;
    // 이전 입력이 해제될 때까지 홀드 시작을 막음.
    if (inputLock) return;
    pointerActive = true;
    if (timerState === "running") {
      stopTimer();
      return;
    }
    if ((timerState === "idle" || timerState === "stopped") && !inspectionActive) {
      if (toggleInspection.checked) {
        startInspection();
        timerState = "inspecting";
        return;
      }
    }
    if (timerState === "idle" || timerState === "stopped" || timerState === "inspecting") {
      beginHold();
    }
  };

  const onUp = (event) => {
    event.preventDefault();
    // 터치를 떼면 잠금을 해제해서 다음 솔브를 시작할 수 있게 함.
    if (inputLock) {
      inputLock = false;
    }
    if (!pointerActive) return;
    pointerActive = false;
    endHold();
  };

  target.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  target.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("touchend", onUp, { passive: false });
  target.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
}

window.addEventListener("resize", () => {
  renderChart();
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  if (isMobile && localStorage.getItem(CHART_USER_KEY) !== "true") {
    localStorage.setItem(CHART_KEY, "false");
  }
  applyVisibilitySettings();
});

window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    const savedTheme = localStorage.getItem(THEME_KEY) || "system";
    if (savedTheme === "system") {
      setTheme("system");
    }
  });

const chartWheelTarget = progressChart?.closest(".chart-card") || progressChart;
chartWheelTarget?.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 5 : -5;
    adjustChartWindow(direction);
  },
  { passive: false },
);

chartZoomOutBtn?.addEventListener("click", () => adjustChartWindow(5));
chartZoomInBtn?.addEventListener("click", () => adjustChartWindow(-5));

async function initApp() {
  try {
    const savedTheme = localStorage.getItem(THEME_KEY) || "system";
    setTheme(savedTheme);
    const savedAccent = localStorage.getItem(ACCENT_KEY) || "ocean";
    setAccentTheme(savedAccent);
    updateAccentSwatches();
    if (localStorage.getItem(PREVIEW_KEY) === null) {
      localStorage.setItem(PREVIEW_KEY, "true");
    }
    const isMobile = window.matchMedia("(max-width: 720px)").matches;
    if (localStorage.getItem(CHART_KEY) === null) {
      localStorage.setItem(CHART_KEY, isMobile ? "false" : "true");
    }
    if (isMobile && localStorage.getItem(CHART_USER_KEY) !== "true") {
      localStorage.setItem(CHART_KEY, "false");
    }
    if (localStorage.getItem(INSPECTION_KEY) === null) {
      localStorage.setItem(INSPECTION_KEY, "false");
    }
    const hideLiveStored = localStorage.getItem(HIDE_LIVE_KEY);
    if (hideLiveStored !== "true" && hideLiveStored !== "false") {
      localStorage.setItem(HIDE_LIVE_KEY, "false");
    }
    if (localStorage.getItem(AO5_KEY) === null) {
      localStorage.setItem(AO5_KEY, "true");
    }
    if (localStorage.getItem(AO12_KEY) === null) {
      localStorage.setItem(AO12_KEY, "true");
    }
    applyVisibilitySettings();
    toggleInspection.checked = localStorage.getItem(INSPECTION_KEY) === "true";
    if (toggleHideLive) {
      toggleHideLive.checked = localStorage.getItem(HIDE_LIVE_KEY) === "true";
      hideLiveUpdates = toggleHideLive.checked;
    }
    if (toggleAo5) toggleAo5.checked = localStorage.getItem(AO5_KEY) !== "false";
    if (toggleAo12) toggleAo12.checked = localStorage.getItem(AO12_KEY) !== "false";
    eventSelect.value = appState.settings.eventId;
    renderAll();
    await generateScramble();
    resetTimer();
    attachTimerPointerControls();
    requestAnimationFrame(() => {
      renderChart();
    });
  } catch (error) {
    console.error("초기화 실패", error);
    scrambleText.textContent = "초기화 실패 (콘솔 확인)";
  }
}

void initApp();
