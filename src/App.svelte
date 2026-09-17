<script>
  import { onMount } from "svelte";

  const STORAGE_KEY = "meeting-minutes-app-v1";
  const MISTRAL_TRANSCRIPTION_ENDPOINT = "/api/transcribe";
  const DEFAULT_MISTRAL_SPEECH_MODEL = "voxtral-mini-latest";
  const MISTRAL_API_KEY_STORAGE_KEY = "MISTRAL_API_KEY";
  const MISTRAL_MODEL_STORAGE_KEY = "MISTRAL_SPEECH_MODEL";
  const MISTRAL_ENDPOINT_STORAGE_KEY = "MISTRAL_TRANSCRIPTION_ENDPOINT";

  const initialState = {
    people: [],
    projects: [],
    minutes: [],
    ui: {
      selectedPersonId: "",
      selectedProjectId: "",
      selectedWeek: mondayOf(new Date()),
    },
  };

  let state = loadState();
  seedIfEmpty();
  ensureValidSelection();
  persist();

  let newPersonName = "";
  let newProjectName = "";
  let editorMarkdown = "";
  let reportHtml = "";
  let mailHref = "#";

  let showPeople = true;
  let showProjects = true;

  let settingsDialog;
  let settingsApiKey = "";
  let settingsModel = DEFAULT_MISTRAL_SPEECH_MODEL;
  let settingsEndpoint = MISTRAL_TRANSCRIPTION_ENDPOINT;

  let speechStatus = "Ready";
  let speechAvailable = false;
  let speechApiKey = "";
  let speechModel = DEFAULT_MISTRAL_SPEECH_MODEL;
  let speechEndpoint = MISTRAL_TRANSCRIPTION_ENDPOINT;
  let mediaRecorder = null;
  let speechStream = null;
  let speechChunks = [];
  let isRecording = false;
  let isTranscribing = false;
  let startedAtMs = 0;
  let stopFallbackTimer = null;
  let activePointerId = null;

  let lastEditorKey = "";

  $: selectedPerson = state.people.find((person) => person.id === state.ui.selectedPersonId) || null;
  $: selectedProjectId = state.ui.selectedProjectId || "";
  $: selectedWeek = state.ui.selectedWeek;
  $: previousWeek = shiftWeek(selectedWeek, -7);
  $: currentEntry = selectedPerson ? findMinutes(selectedPerson.id, selectedProjectId, selectedWeek) : null;
  $: previousEntry = selectedPerson ? findMinutes(selectedPerson.id, selectedProjectId, previousWeek) : null;
  $: previousMarkdown = previousEntry ? previousEntry.markdown : "";
  $: previousWeekHtml = previousMarkdown ? renderMarkdown(previousMarkdown) : "No minutes from last week.";
  $: previousWeekIsEmpty = !previousMarkdown;
  $: previewHtml = renderMarkdown(editorMarkdown);

  $: activeEditorKey = selectedPerson ? `${selectedPerson.id}::${selectedProjectId}::${selectedWeek}` : "";
  $: {
    if (activeEditorKey !== lastEditorKey) {
      const markdown = currentEntry ? currentEntry.markdown : previousMarkdown;
      editorMarkdown = markdown || "";
      lastEditorKey = activeEditorKey;
    }
  }

  onMount(() => {
    setupSpeechControls();
    return () => {
      cleanupSpeech();
    };
  });

  function setState(nextState) {
    state = nextState;
  }

  function updateState(updater, shouldPersist = true) {
    const next = structuredClone(state);
    updater(next);
    setState(next);
    if (shouldPersist) persist();
  }

  function addPerson() {
    const name = newPersonName.trim();
    if (!name) return;
    updateState((next) => {
      const person = { id: uid("person"), name, projectIds: [] };
      next.people.push(person);
      if (!next.ui.selectedPersonId) next.ui.selectedPersonId = person.id;
      ensureValidSelection(next);
    });
    newPersonName = "";
  }

  function addProject() {
    const name = newProjectName.trim();
    if (!name) return;
    updateState((next) => {
      const project = { id: uid("project"), name };
      next.projects.push(project);
      if (!next.ui.selectedProjectId) next.ui.selectedProjectId = project.id;
      ensureValidSelection(next);
    });
    newProjectName = "";
  }

  function selectPerson(personId) {
    updateState((next) => {
      next.ui.selectedPersonId = personId;
      ensureValidSelection(next);
    });
  }

  function selectProject(projectId) {
    updateState((next) => {
      next.ui.selectedProjectId = projectId;
      ensureValidSelection(next);
    });
  }

  function changeWeek(value) {
    updateState((next) => {
      next.ui.selectedWeek = normalizeWeekString(value);
    });
  }

  function toggleProjectAssignment(projectId, checked) {
    if (!selectedPerson) return;
    updateState((next) => {
      const person = next.people.find((entry) => entry.id === next.ui.selectedPersonId);
      if (!person) return;
      if (checked) {
        if (!person.projectIds.includes(projectId)) person.projectIds.push(projectId);
      } else {
        person.projectIds = person.projectIds.filter((id) => id !== projectId);
      }
    });
  }

  function editPerson(personId) {
    const person = state.people.find((entry) => entry.id === personId);
    if (!person) return;
    const nextName = window.prompt("Edit person name:", person.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    updateState((next) => {
      const target = next.people.find((entry) => entry.id === personId);
      if (target) target.name = trimmed;
    });
  }

  function deletePerson(personId) {
    const person = state.people.find((entry) => entry.id === personId);
    if (!person) return;
    const shouldDelete = window.confirm(`Delete ${person.name} and their minutes?`);
    if (!shouldDelete) return;
    updateState((next) => {
      next.people = next.people.filter((entry) => entry.id !== personId);
      next.minutes = next.minutes.filter((entry) => entry.personId !== personId);
      ensureValidSelection(next);
    });
  }

  function editProject(projectId) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const nextName = window.prompt("Edit project name:", project.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    updateState((next) => {
      const target = next.projects.find((entry) => entry.id === projectId);
      if (target) target.name = trimmed;
    });
  }

  function deleteProject(projectId) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const shouldDelete = window.confirm(`Delete project ${project.name}?`);
    if (!shouldDelete) return;
    updateState((next) => {
      next.projects = next.projects.filter((entry) => entry.id !== projectId);
      next.people.forEach((person) => {
        person.projectIds = person.projectIds.filter((id) => id !== projectId);
      });
      next.minutes = next.minutes.filter((entry) => entry.projectId !== projectId);
      ensureValidSelection(next);
    });
  }

  function saveCurrentMinutes() {
    if (!selectedPerson) return;
    const markdown = editorMarkdown.trim();
    if (!markdown) return;
    updateState((next) => {
      const existing = next.minutes.find(
        (entry) =>
          entry.personId === next.ui.selectedPersonId &&
          entry.projectId === (next.ui.selectedProjectId || "") &&
          entry.week === next.ui.selectedWeek
      );
      if (existing) {
        existing.markdown = markdown;
        existing.updatedAt = new Date().toISOString();
        return;
      }
      next.minutes.push({
        id: uid("minutes"),
        personId: next.ui.selectedPersonId,
        projectId: next.ui.selectedProjectId || "",
        week: next.ui.selectedWeek,
        markdown,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  function generateReport() {
    saveCurrentMinutes();
    reportHtml = generateReportHtml(state.ui.selectedWeek);
    const subject = encodeURIComponent(`Weekly Progress Report - ${state.ui.selectedWeek}`);
    const body = encodeURIComponent(htmlToEmailText(reportHtml));
    mailHref = `mailto:?subject=${subject}&body=${body}`;
  }

  function openSettingsDialog() {
    settingsApiKey = getMistralApiKey();
    settingsModel = getMistralSpeechModel();
    settingsEndpoint = getMistralTranscriptionEndpoint();
    settingsDialog.showModal();
  }

  function clearMistralKey() {
    localStorage.removeItem(MISTRAL_API_KEY_STORAGE_KEY);
    localStorage.removeItem(MISTRAL_MODEL_STORAGE_KEY);
    localStorage.removeItem(MISTRAL_ENDPOINT_STORAGE_KEY);
    settingsApiKey = "";
    settingsModel = DEFAULT_MISTRAL_SPEECH_MODEL;
    settingsEndpoint = MISTRAL_TRANSCRIPTION_ENDPOINT;
    setupSpeechControls();
  }

  function saveSettings() {
    const apiKey = settingsApiKey.trim();
    const model = settingsModel.trim() || DEFAULT_MISTRAL_SPEECH_MODEL;
    const endpoint = settingsEndpoint.trim() || MISTRAL_TRANSCRIPTION_ENDPOINT;
    if (apiKey) {
      localStorage.setItem(MISTRAL_API_KEY_STORAGE_KEY, apiKey);
    } else {
      localStorage.removeItem(MISTRAL_API_KEY_STORAGE_KEY);
    }
    localStorage.setItem(MISTRAL_MODEL_STORAGE_KEY, model);
    localStorage.setItem(MISTRAL_ENDPOINT_STORAGE_KEY, endpoint);
    setupSpeechControls();
    settingsDialog.close();
  }

  function setupSpeechControls() {
    const apiKey = getMistralApiKey();
    speechAvailable =
      Boolean(apiKey) &&
      typeof window.MediaRecorder !== "undefined" &&
      Boolean(navigator.mediaDevices) &&
      typeof navigator.mediaDevices.getUserMedia === "function";
    speechApiKey = apiKey;
    speechModel = getMistralSpeechModel();
    speechEndpoint = getMistralTranscriptionEndpoint();
    speechStatus = speechAvailable ? `Ready to record (${speechModel})` : "Configure API key in Settings.";
  }

  async function startPushToTalk(event) {
    if (!speechAvailable || isRecording || isTranscribing) return;
    if (!event.isPrimary) return;
    activePointerId = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // best effort
    }

    try {
      speechStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      speechChunks = [];
      const mimeType = getSupportedRecordingMimeType();
      mediaRecorder = mimeType ? new MediaRecorder(speechStream, { mimeType }) : new MediaRecorder(speechStream);
      mediaRecorder.addEventListener("dataavailable", (evt) => {
        if (evt.data && evt.data.size > 0) speechChunks.push(evt.data);
      });
      mediaRecorder.addEventListener("stop", onRecordingStopped);
      mediaRecorder.start(250);
      startedAtMs = Date.now();
      isRecording = true;
      clearSpeechStopTimer();
      stopFallbackTimer = setTimeout(() => stopPushToTalk(event), 30000);
      speechStatus = "Recording...";
    } catch (error) {
      speechStatus = `Microphone error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  }

  function stopPushToTalk(event) {
    if (!isRecording || !mediaRecorder) return;
    if (
      event &&
      activePointerId !== null &&
      typeof event.pointerId === "number" &&
      event.pointerId !== activePointerId
    ) {
      return;
    }
    activePointerId = null;
    clearSpeechStopTimer();
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.requestData();
      mediaRecorder.stop();
    }
    isRecording = false;
    isTranscribing = true;
    speechStatus = "Transcribing...";
  }

  async function onRecordingStopped() {
    try {
      const mimeType = mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : "audio/webm";
      const durationMs = Date.now() - startedAtMs;
      const totalBytes = speechChunks.reduce((sum, chunk) => sum + chunk.size, 0);
      if (totalBytes === 0 || durationMs < 200) {
        speechStatus = "No audio captured. Hold the button while speaking.";
        return;
      }
      const audioBlob = new Blob(speechChunks, { type: mimeType });
      const transcript = await transcribeWithMistral(audioBlob, mimeType);
      if (!transcript) {
        speechStatus = "No speech detected. Try speaking closer to the mic.";
        return;
      }
      insertTranscript(transcript);
      speechStatus = "Transcription added.";
    } catch (error) {
      speechStatus = formatSpeechError(error);
    } finally {
      cleanupSpeech();
      isTranscribing = false;
      startedAtMs = 0;
    }
  }

  function cleanupSpeech() {
    clearSpeechStopTimer();
    if (speechStream) {
      speechStream.getTracks().forEach((track) => track.stop());
    }
    speechStream = null;
    mediaRecorder = null;
    speechChunks = [];
    isRecording = false;
  }

  async function transcribeWithMistral(audioBlob, mimeType) {
    const formData = new FormData();
    const fileExt = mimeType.includes("ogg") ? "ogg" : "webm";
    const audioFile = new File([audioBlob], `meeting-note.${fileExt}`, { type: mimeType });
    formData.append("file", audioFile);
    formData.append("model", speechModel);

    const response = await fetch(speechEndpoint, {
      method: "POST",
      headers: buildSpeechHeaders(),
      body: formData,
    });

    if (!response.ok) {
      const details = await response.text();
      if (response.status === 403) {
        throw new Error(
          "HTTP 403 from transcription endpoint. Check API key format in Settings (key only, no 'Bearer ' prefix) and Vercel endpoint access."
        );
      }
      throw new Error(`HTTP ${response.status}: ${details || "Request failed"}`);
    }

    const payload = await response.json();
    return getTranscriptFromPayload(payload);
  }

  function insertTranscript(transcript) {
    const prefix = editorMarkdown && !editorMarkdown.endsWith("\n") ? "\n" : "";
    editorMarkdown = `${editorMarkdown}${prefix}${transcript}\n`;
  }

  function buildSpeechHeaders() {
    const headers = {};
    const auth = toBearerToken(speechApiKey);
    if (auth) headers.Authorization = auth;
    return headers;
  }

  function toBearerToken(value) {
    if (!value || typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed;
    return `Bearer ${trimmed}`;
  }

  function getSupportedRecordingMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    const match = candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
    return match || "";
  }

  function getTranscriptFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
    if (typeof payload.transcript === "string" && payload.transcript.trim()) return payload.transcript.trim();
    if (payload.data && typeof payload.data.text === "string" && payload.data.text.trim()) return payload.data.text.trim();
    if (payload.result && typeof payload.result.text === "string" && payload.result.text.trim()) return payload.result.text.trim();
    if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
    if (Array.isArray(payload.outputs)) {
      const fromOutputs = payload.outputs
        .map((entry) => (entry && typeof entry.text === "string" ? entry.text.trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (fromOutputs) return fromOutputs;
    }
    if (Array.isArray(payload.segments)) {
      const fromSegments = payload.segments
        .map((entry) => (entry && typeof entry.text === "string" ? entry.text.trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (fromSegments) return fromSegments;
    }
    if (payload.data && Array.isArray(payload.data.segments)) {
      const fromDataSegments = payload.data.segments
        .map((entry) => (entry && typeof entry.text === "string" ? entry.text.trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (fromDataSegments) return fromDataSegments;
    }
    return "";
  }

  function clearSpeechStopTimer() {
    if (!stopFallbackTimer) return;
    clearTimeout(stopFallbackTimer);
    stopFallbackTimer = null;
  }

  function formatSpeechError(error) {
    if (error instanceof TypeError) {
      return "Transcription failed: network error. Check endpoint in Settings (/api/transcribe by default).";
    }
    if (error instanceof Error) {
      return `Transcription failed: ${error.message}`;
    }
    return "Transcription failed: Unknown error";
  }

  function generateReportHtml(week) {
    const rows = state.minutes.filter((entry) => entry.week === week);
    if (!rows.length) {
      return `<h2>Weekly Progress Report (${escapeHtml(week)})</h2><p>No updates available for this week.</p>`;
    }

    const html = [
      `<h2>Weekly Progress Report (${escapeHtml(week)})</h2>`,
      "<p>Hello team,</p>",
      "<p>Here is this week's progress summary.</p>",
    ];

    state.people.forEach((person) => {
      const personRows = rows.filter((row) => row.personId === person.id);
      if (!personRows.length) return;
      html.push(`<h3>${escapeHtml(person.name)}</h3>`);

      const projectsWithGeneral = [{ id: "", name: "General Updates" }, ...state.projects];
      projectsWithGeneral.forEach((project) => {
        const group = personRows.filter((row) => row.projectId === project.id);
        if (!group.length) return;
        html.push(`<h4>${escapeHtml(project.name)}</h4>`);
        group.forEach((row) => {
          const lastWeek = shiftWeek(week, -7);
          const lastEntry = findMinutes(person.id, project.id, lastWeek);
          const currentHtml = renderMarkdown(row.markdown) || "<p>-</p>";
          const lastHtml = lastEntry ? renderMarkdown(lastEntry.markdown) : "<p>-</p>";
          html.push(
            `<table class="report-table"><thead><tr><th>Current week</th><th>Last week</th></tr></thead><tbody><tr><td>${currentHtml}</td><td>${lastHtml}</td></tr></tbody></table>`
          );
        });
      });
    });

    html.push("<p>Best regards,<br>Team</p>");
    return html.join("");
  }

  function renderMarkdown(markdown) {
    if (!markdown) return "";
    const escaped = escapeHtml(markdown);
    const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
    const withBold = withCode.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const withItalic = withBold.replace(/\*(.+?)\*/g, "<em>$1</em>");
    const lines = withItalic.split("\n");
    const html = [];
    let inList = false;
    lines.forEach((line) => {
      if (/^- /.test(line)) {
        if (!inList) {
          html.push("<ul>");
          inList = true;
        }
        html.push(`<li>${line.slice(2)}</li>`);
        return;
      }
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      if (/^### /.test(line)) {
        html.push(`<h3>${line.slice(4)}</h3>`);
      } else if (/^## /.test(line)) {
        html.push(`<h2>${line.slice(3)}</h2>`);
      } else if (/^# /.test(line)) {
        html.push(`<h1>${line.slice(2)}</h1>`);
      } else if (line.trim()) {
        html.push(`<p>${line}</p>`);
      }
    });
    if (inList) html.push("</ul>");
    return html.join("");
  }

  function htmlToEmailText(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container.innerText.replace(/\n{3,}/g, "\n\n").trim();
  }

  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function findMinutes(personId, projectId, week) {
    return state.minutes.find(
      (entry) => entry.personId === personId && entry.projectId === projectId && entry.week === week
    );
  }

  function getMistralApiKey() {
    const key = localStorage.getItem(MISTRAL_API_KEY_STORAGE_KEY);
    return key && key.trim() ? key.trim() : "";
  }

  function getMistralSpeechModel() {
    const model = localStorage.getItem(MISTRAL_MODEL_STORAGE_KEY);
    return model && model.trim() ? model.trim() : DEFAULT_MISTRAL_SPEECH_MODEL;
  }

  function getMistralTranscriptionEndpoint() {
    const endpoint = localStorage.getItem(MISTRAL_ENDPOINT_STORAGE_KEY);
    return endpoint && endpoint.trim() ? endpoint.trim() : MISTRAL_TRANSCRIPTION_ENDPOINT;
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(initialState);
    try {
      const parsed = JSON.parse(raw);
      return normalizeLoadedState({
        ...structuredClone(initialState),
        ...parsed,
        ui: { ...initialState.ui, ...(parsed.ui || {}) },
      });
    } catch {
      return structuredClone(initialState);
    }
  }

  function normalizeLoadedState(candidate) {
    return {
      ...candidate,
      people: Array.isArray(candidate.people) ? candidate.people : [],
      projects: Array.isArray(candidate.projects) ? candidate.projects : [],
      minutes: normalizeMinutes(Array.isArray(candidate.minutes) ? candidate.minutes : []),
      ui: {
        ...initialState.ui,
        ...(candidate.ui || {}),
        selectedWeek: normalizeWeekString(candidate.ui && candidate.ui.selectedWeek),
      },
    };
  }

  function normalizeMinutes(minutes) {
    const latestByKey = new Map();
    minutes.forEach((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.personId !== "string" || !entry.personId) return;
      const projectId = typeof entry.projectId === "string" ? entry.projectId : "";
      const week = normalizeWeekString(entry.week);
      const normalized = { ...entry, projectId, week };
      const key = `${entry.personId}::${projectId}::${week}`;
      const existing = latestByKey.get(key);
      if (!existing || isNewerEntry(normalized, existing)) latestByKey.set(key, normalized);
    });
    return Array.from(latestByKey.values());
  }

  function isNewerEntry(left, right) {
    const leftTs = Date.parse(left.updatedAt || "");
    const rightTs = Date.parse(right.updatedAt || "");
    if (Number.isNaN(leftTs) && Number.isNaN(rightTs)) return true;
    if (Number.isNaN(leftTs)) return false;
    if (Number.isNaN(rightTs)) return true;
    return leftTs >= rightTs;
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function parseIsoDate(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }
    return parsed;
  }

  function formatIsoDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function toUtcDay(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    }
    if (typeof value === "string") return parseIsoDate(value);
    return null;
  }

  function mondayOf(value) {
    const d = toUtcDay(value) || toUtcDay(new Date());
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return formatIsoDate(d);
  }

  function shiftWeek(yyyyMmDd, deltaDays) {
    const d = parseIsoDate(yyyyMmDd);
    if (!d) return mondayOf(new Date());
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return formatIsoDate(d);
  }

  function normalizeWeekString(value) {
    const parsed = parseIsoDate(value);
    if (!parsed) return mondayOf(new Date());
    return mondayOf(parsed);
  }

  function ensureValidSelection(candidate = state) {
    const personExists = candidate.people.some((person) => person.id === candidate.ui.selectedPersonId);
    if (!personExists) candidate.ui.selectedPersonId = candidate.people[0] ? candidate.people[0].id : "";
    const projectExists = candidate.projects.some((project) => project.id === candidate.ui.selectedProjectId);
    if (!projectExists) candidate.ui.selectedProjectId = "";
  }

  function seedIfEmpty() {
    if (!state.people.length) {
      const alice = { id: uid("person"), name: "Alice", projectIds: [] };
      const bob = { id: uid("person"), name: "Bob", projectIds: [] };
      state.people.push(alice, bob);
      state.ui.selectedPersonId = alice.id;
    }
    if (!state.projects.length) {
      const alpha = { id: uid("project"), name: "Alpha" };
      const beta = { id: uid("project"), name: "Beta" };
      state.projects.push(alpha, beta);
      state.ui.selectedProjectId = alpha.id;
      state.people[0].projectIds.push(alpha.id);
      state.people[1].projectIds.push(beta.id);
    }
  }
</script>

<header class="container-fluid topbar">
  <h1 class="app-title">Weekly Meeting Minutes</h1>
  <nav class="topbar-actions">
    <button class="secondary outline" type="button" on:click={openSettingsDialog}>Settings</button>
    <button class="secondary outline" type="button" on:click={() => (showPeople = !showPeople)}>
      {showPeople ? "Hide People" : "Show People"}
    </button>
    <button class="secondary outline" type="button" on:click={() => (showProjects = !showProjects)}>
      {showProjects ? "Hide Projects" : "Show Projects"}
    </button>
  </nav>
</header>

<main class="container-fluid app-layout">
  <aside class={`sidebar left ${showPeople ? "" : "hidden"}`}>
    <article class="panel">
      <h2>People</h2>
      <ul class="item-list">
        {#each state.people as person}
          <li class:active={selectedPerson && person.id === selectedPerson.id}>
            <div class="item-row">
              <button class="item-select-btn" type="button" on:click={() => selectPerson(person.id)}>{person.name}</button>
              <div class="item-actions">
                <button class="icon-btn secondary outline" type="button" on:click={() => editPerson(person.id)}>✏️</button>
                <button class="icon-btn secondary outline" type="button" on:click={() => deletePerson(person.id)}>🗑️</button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
      <form
        class="inline-form"
        on:submit|preventDefault={addPerson}
      >
        <input bind:value={newPersonName} type="text" placeholder="New person name" required />
        <button type="submit">Add</button>
      </form>
    </article>
  </aside>

  <section class="center">
    <article class="panel">
      <div class="toolbar">
        <div class="toolbar-group">
          <label>
            Person
            <select value={state.ui.selectedPersonId} on:change={(e) => selectPerson(e.currentTarget.value)}>
              {#if !state.people.length}
                <option value="">No people</option>
              {/if}
              {#each state.people as person}
                <option value={person.id}>{person.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Project
            <select value={state.ui.selectedProjectId} on:change={(e) => selectProject(e.currentTarget.value)}>
              <option value="">General update</option>
              {#each state.projects as project}
                <option value={project.id}>{project.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Week of
            <input type="date" value={state.ui.selectedWeek} on:input={(e) => changeWeek(e.currentTarget.value)} />
          </label>
        </div>
        <div class="toolbar-group">
          <button type="button" on:click={saveCurrentMinutes}>Save Minutes</button>
          <button type="button" on:click={generateReport}>Generate Report</button>
        </div>
      </div>
    </article>

    <div class="editor-grid">
      <article class="panel">
        <h3>Last Week (reference)</h3>
        <div class={`markdown-view ${previousWeekIsEmpty ? "empty-state" : ""}`}>
          {@html previousWeekHtml}
        </div>
      </article>

      <article class="panel">
        <h3>Current Week (edit)</h3>
        {#if speechAvailable}
          <div class="speech-controls">
            <button
              class={`speech-btn secondary ${isRecording ? "recording" : ""}`}
              type="button"
              disabled={isTranscribing}
              on:pointerdown={startPushToTalk}
              on:pointerup={stopPushToTalk}
              on:pointercancel={stopPushToTalk}
              on:lostpointercapture={stopPushToTalk}
            >
              {isRecording ? "Release to stop" : "Hold to talk"}
            </button>
            <span class="helper-text">{speechStatus}</span>
          </div>
        {/if}
        <textarea
          class="editor"
          placeholder="Write weekly progress in markdown..."
          bind:value={editorMarkdown}
        ></textarea>
        <h4>Preview</h4>
        <div class="markdown-view">
          {@html previewHtml}
        </div>
      </article>
    </div>

    <article class="panel">
      <h3>Generated Progress Report</h3>
      <div class={`report-render ${reportHtml ? "" : "empty-state"}`}>
        {#if reportHtml}
          {@html reportHtml}
        {:else}
          Click "Generate Report" to build a mail-ready summary.
        {/if}
      </div>
      <a class="mail-link" href={mailHref} target="_blank" rel="noreferrer noopener">Open in email draft</a>
    </article>
  </section>

  <aside class={`sidebar right ${showProjects ? "" : "hidden"}`}>
    <article class="panel">
      <h2>Projects</h2>
      <ul class="item-list">
        {#each state.projects as project}
          <li class:active={project.id === state.ui.selectedProjectId}>
            <div class="item-row">
              <button class="item-select-btn" type="button" on:click={() => selectProject(project.id)}>{project.name}</button>
              <div class="item-actions">
                <button class="icon-btn secondary outline" type="button" on:click={() => editProject(project.id)}>✏️</button>
                <button class="icon-btn secondary outline" type="button" on:click={() => deleteProject(project.id)}>🗑️</button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
      <form
        class="inline-form"
        on:submit|preventDefault={addProject}
      >
        <input bind:value={newProjectName} type="text" placeholder="New project name" required />
        <button type="submit">Add</button>
      </form>

      <hr />
      <h3>Assignments</h3>
      <p class="helper-text">Select a person, then tick assigned projects.</p>
      <div class="assignment-box">
        {#if !selectedPerson}
          <p class="helper-text">Add and select a person first.</p>
        {:else if !state.projects.length}
          <p class="helper-text">Add a project to assign it.</p>
        {:else}
          {#each state.projects as project}
            <label class="helper-text">
              <input
                type="checkbox"
                checked={selectedPerson.projectIds.includes(project.id)}
                on:change={(e) => toggleProjectAssignment(project.id, e.currentTarget.checked)}
              />
              {project.name}
            </label>
          {/each}
        {/if}
      </div>
    </article>
  </aside>
</main>

<dialog bind:this={settingsDialog} class="settings-dialog">
  <form class="settings-form" method="dialog" on:submit|preventDefault={saveSettings}>
    <h3>Settings</h3>
    <label>
      Mistral API key
      <input bind:value={settingsApiKey} type="password" placeholder="Paste API key" autocomplete="off" />
    </label>
    <label>
      Speech model
      <input bind:value={settingsModel} type="text" placeholder="voxtral-mini-latest" autocomplete="off" />
    </label>
    <label>
      Transcription endpoint (optional proxy)
      <input bind:value={settingsEndpoint} type="text" placeholder="/api/transcribe" autocomplete="off" />
    </label>
    <p class="helper-text">Saved locally in this browser and used for push-to-talk transcription.</p>
    <div class="settings-actions">
      <button class="secondary outline" type="button" on:click={clearMistralKey}>Clear key</button>
      <button class="secondary outline" type="button" on:click={() => settingsDialog.close()}>Cancel</button>
      <button type="submit">Save</button>
    </div>
  </form>
</dialog>
