(function () {
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

  const state = loadState();

  const el = {
    peopleList: document.getElementById("peopleList"),
    projectList: document.getElementById("projectList"),
    personSelect: document.getElementById("personSelect"),
    projectSelect: document.getElementById("projectSelect"),
    assignmentBox: document.getElementById("assignmentBox"),
    editor: document.getElementById("editor"),
    preview: document.getElementById("preview"),
    lastWeekView: document.getElementById("lastWeekView"),
    weekInput: document.getElementById("weekInput"),
    reportOutput: document.getElementById("reportOutput"),
    mailLink: document.getElementById("mailLink"),
    openSettings: document.getElementById("openSettings"),
    settingsDialog: document.getElementById("settingsDialog"),
    settingsForm: document.getElementById("settingsForm"),
    mistralApiKeyInput: document.getElementById("mistralApiKeyInput"),
    mistralModelInput: document.getElementById("mistralModelInput"),
    mistralEndpointInput: document.getElementById("mistralEndpointInput"),
    clearMistralKey: document.getElementById("clearMistralKey"),
    cancelSettings: document.getElementById("cancelSettings"),
    speechControls: document.getElementById("speechControls"),
    pushToTalkButton: document.getElementById("pushToTalkButton"),
    speechStatus: document.getElementById("speechStatus"),
    addPersonForm: document.getElementById("addPersonForm"),
    personNameInput: document.getElementById("personNameInput"),
    addProjectForm: document.getElementById("addProjectForm"),
    projectNameInput: document.getElementById("projectNameInput"),
    saveButton: document.getElementById("saveButton"),
    generateButton: document.getElementById("generateButton"),
    togglePeople: document.getElementById("togglePeople"),
    toggleProjects: document.getElementById("toggleProjects"),
    peopleSidebar: document.getElementById("peopleSidebar"),
    projectsSidebar: document.getElementById("projectsSidebar"),
  };

  const speechState = {
    available: false,
    apiKey: "",
    model: DEFAULT_MISTRAL_SPEECH_MODEL,
    endpoint: MISTRAL_TRANSCRIPTION_ENDPOINT,
    mediaRecorder: null,
    stream: null,
    chunks: [],
    isRecording: false,
    isTranscribing: false,
    startedAtMs: 0,
    activePointerId: null,
    stopFallbackTimer: null,
  };

  wireEvents();
  setupSpeechControls();
  seedIfEmpty();
  hydrateUI();

  function wireEvents() {
    el.addPersonForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = el.personNameInput.value.trim();
      if (!name) return;
      const person = { id: uid("person"), name, projectIds: [] };
      state.people.push(person);
      if (!state.ui.selectedPersonId) {
        state.ui.selectedPersonId = person.id;
      }
      el.personNameInput.value = "";
      persistAndRender();
    });

    el.addProjectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = el.projectNameInput.value.trim();
      if (!name) return;
      const project = { id: uid("project"), name };
      state.projects.push(project);
      if (!state.ui.selectedProjectId) {
        state.ui.selectedProjectId = project.id;
      }
      el.projectNameInput.value = "";
      persistAndRender();
    });

    el.personSelect.addEventListener("change", () => {
      state.ui.selectedPersonId = el.personSelect.value;
      persistAndRender();
    });

    el.projectSelect.addEventListener("change", () => {
      state.ui.selectedProjectId = el.projectSelect.value;
      persistAndRender();
    });

    el.weekInput.addEventListener("change", () => {
      state.ui.selectedWeek = el.weekInput.value || mondayOf(new Date());
      persistAndRender();
    });

    el.editor.addEventListener("input", () => {
      el.preview.innerHTML = renderMarkdown(el.editor.value);
    });

    el.saveButton.addEventListener("click", () => {
      saveCurrentMinutes();
      persistAndRender();
    });

    el.generateButton.addEventListener("click", () => {
      saveCurrentMinutes();
      const reportHtml = generateReportHtml(state.ui.selectedWeek);
      el.reportOutput.classList.remove("empty-state");
      el.reportOutput.innerHTML = reportHtml;
      const subject = encodeURIComponent(`Weekly Progress Report - ${state.ui.selectedWeek}`);
      const body = encodeURIComponent(htmlToEmailText(reportHtml));
      el.mailLink.href = `mailto:?subject=${subject}&body=${body}`;
      persist();
    });

    el.togglePeople.addEventListener("click", () => {
      el.peopleSidebar.classList.toggle("collapsed");
      el.togglePeople.textContent = el.peopleSidebar.classList.contains("collapsed")
        ? "Show People"
        : "Hide People";
    });

    el.toggleProjects.addEventListener("click", () => {
      el.projectsSidebar.classList.toggle("collapsed");
      el.toggleProjects.textContent = el.projectsSidebar.classList.contains("collapsed")
        ? "Show Projects"
        : "Hide Projects";
    });

    el.openSettings.addEventListener("click", () => {
      openSettingsDialog();
    });

    el.cancelSettings.addEventListener("click", () => {
      el.settingsDialog.close();
    });

    el.clearMistralKey.addEventListener("click", () => {
      localStorage.removeItem(MISTRAL_API_KEY_STORAGE_KEY);
      el.mistralApiKeyInput.value = "";
      localStorage.removeItem(MISTRAL_MODEL_STORAGE_KEY);
      el.mistralModelInput.value = DEFAULT_MISTRAL_SPEECH_MODEL;
      localStorage.removeItem(MISTRAL_ENDPOINT_STORAGE_KEY);
      el.mistralEndpointInput.value = MISTRAL_TRANSCRIPTION_ENDPOINT;
      setupSpeechControls();
    });

    el.settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const apiKey = el.mistralApiKeyInput.value.trim();
      const model = el.mistralModelInput.value.trim() || DEFAULT_MISTRAL_SPEECH_MODEL;
      const endpoint = el.mistralEndpointInput.value.trim() || MISTRAL_TRANSCRIPTION_ENDPOINT;
      if (apiKey) {
        localStorage.setItem(MISTRAL_API_KEY_STORAGE_KEY, apiKey);
      } else {
        localStorage.removeItem(MISTRAL_API_KEY_STORAGE_KEY);
      }
      localStorage.setItem(MISTRAL_MODEL_STORAGE_KEY, model);
      localStorage.setItem(MISTRAL_ENDPOINT_STORAGE_KEY, endpoint);
      setupSpeechControls();
      el.settingsDialog.close();
    });

    el.pushToTalkButton.addEventListener("pointerdown", async (event) => {
      if (!event.isPrimary) return;
      event.preventDefault();
      speechState.activePointerId = event.pointerId;
      try {
        el.pushToTalkButton.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort.
      }
      await startPushToTalk();
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => {
      el.pushToTalkButton.addEventListener(eventName, (event) => {
        if (speechState.activePointerId !== null && event.pointerId !== speechState.activePointerId) return;
        speechState.activePointerId = null;
        stopPushToTalk();
      });
    });
  }

  function setupSpeechControls() {
    const apiKey = getMistralApiKey();
    const canRecord =
      Boolean(apiKey) &&
      typeof window.MediaRecorder !== "undefined" &&
      Boolean(navigator.mediaDevices) &&
      typeof navigator.mediaDevices.getUserMedia === "function";

    speechState.available = canRecord;
    speechState.apiKey = apiKey;
    speechState.model = getMistralSpeechModel();
    speechState.endpoint = getMistralTranscriptionEndpoint();
    if (!canRecord) {
      el.speechControls.classList.add("hidden");
      return;
    }

    el.speechControls.classList.remove("hidden");
    setSpeechStatus(`Ready to record (${speechState.model})`);
  }

  function openSettingsDialog() {
    el.mistralApiKeyInput.value = getMistralApiKey();
    el.mistralModelInput.value = getMistralSpeechModel();
    el.mistralEndpointInput.value = getMistralTranscriptionEndpoint();
    el.settingsDialog.showModal();
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
    persist();
  }

  function hydrateUI() {
    ensureValidSelection();
    renderPeople();
    renderProjects();
    renderSelectors();
    renderAssignments();
    renderWeeklyEditors();
    if (el.reportOutput.classList.contains("empty-state")) {
      el.mailLink.href = "#";
    }
  }

  function persistAndRender() {
    persist();
    hydrateUI();
  }

  function renderPeople() {
    el.peopleList.innerHTML = "";
    const selected = selectedPerson();
    state.people.forEach((person) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "item-row";
      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = person.name;
      const actions = document.createElement("div");
      actions.className = "item-actions";
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "icon-btn";
      editButton.title = "Edit person";
      editButton.textContent = "✏️";
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editPerson(person.id);
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "icon-btn";
      deleteButton.title = "Delete person";
      deleteButton.textContent = "🗑️";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deletePerson(person.id);
      });
      actions.append(editButton, deleteButton);
      row.append(name, actions);
      li.appendChild(row);
      if (selected && person.id === selected.id) {
        li.classList.add("active");
      }
      li.addEventListener("click", () => {
        state.ui.selectedPersonId = person.id;
        persistAndRender();
      });
      el.peopleList.appendChild(li);
    });
  }

  function renderProjects() {
    el.projectList.innerHTML = "";
    state.projects.forEach((project) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "item-row";
      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = project.name;
      const actions = document.createElement("div");
      actions.className = "item-actions";
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "icon-btn";
      editButton.title = "Edit project";
      editButton.textContent = "✏️";
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editProject(project.id);
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "icon-btn";
      deleteButton.title = "Delete project";
      deleteButton.textContent = "🗑️";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProject(project.id);
      });
      actions.append(editButton, deleteButton);
      row.append(name, actions);
      li.appendChild(row);
      if (project.id === state.ui.selectedProjectId) {
        li.classList.add("active");
      }
      li.addEventListener("click", () => {
        state.ui.selectedProjectId = project.id;
        persistAndRender();
      });
      el.projectList.appendChild(li);
    });
  }

  function renderSelectors() {
    const currentPerson = selectedPerson();
    el.personSelect.innerHTML = "";
    if (!state.people.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No people";
      el.personSelect.appendChild(option);
      el.personSelect.value = "";
    }
    state.people.forEach((person) => {
      const option = document.createElement("option");
      option.value = person.id;
      option.textContent = person.name;
      if (currentPerson && person.id === currentPerson.id) option.selected = true;
      el.personSelect.appendChild(option);
    });

    const currentProjectId = state.ui.selectedProjectId || "";
    el.projectSelect.innerHTML = "";
    const generalOption = document.createElement("option");
    generalOption.value = "";
    generalOption.textContent = "General update";
    el.projectSelect.appendChild(generalOption);
    state.projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      if (project.id === currentProjectId) option.selected = true;
      el.projectSelect.appendChild(option);
    });
    if (!currentProjectId) {
      el.projectSelect.value = "";
    }

    el.weekInput.value = state.ui.selectedWeek;
  }

  function renderAssignments() {
    el.assignmentBox.innerHTML = "";
    const person = selectedPerson();
    if (!person) {
      el.assignmentBox.textContent = "Add and select a person first.";
      return;
    }
    if (!state.projects.length) {
      el.assignmentBox.textContent = "Add a project to assign it.";
      return;
    }

    state.projects.forEach((project) => {
      const row = document.createElement("label");
      row.className = "helper-text";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = person.projectIds.includes(project.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (!person.projectIds.includes(project.id)) person.projectIds.push(project.id);
        } else {
          person.projectIds = person.projectIds.filter((id) => id !== project.id);
        }
        persistAndRender();
      });

      row.appendChild(checkbox);
      row.append(` ${project.name}`);
      el.assignmentBox.appendChild(row);
    });
  }

  function renderWeeklyEditors() {
    const person = selectedPerson();
    if (!person) {
      el.lastWeekView.textContent = "No person selected.";
      el.editor.value = "";
      el.preview.innerHTML = "";
      return;
    }

    const week = state.ui.selectedWeek;
    const projectId = state.ui.selectedProjectId || "";
    const lastWeek = shiftWeek(week, -7);
    const lastEntry = findMinutes(person.id, projectId, lastWeek);
    const currentEntry = findMinutes(person.id, projectId, week);

    const lastMarkdown = lastEntry ? lastEntry.markdown : "";
    el.lastWeekView.classList.toggle("empty-state", !lastMarkdown);
    el.lastWeekView.innerHTML = lastMarkdown
      ? renderMarkdown(lastMarkdown)
      : "No minutes from last week.";

    const currentMarkdown = currentEntry ? currentEntry.markdown : lastMarkdown;
    el.editor.value = currentMarkdown;
    el.preview.innerHTML = renderMarkdown(currentMarkdown);
  }

  function saveCurrentMinutes() {
    const person = selectedPerson();
    if (!person) return;

    const week = state.ui.selectedWeek;
    const projectId = state.ui.selectedProjectId || "";
    const markdown = el.editor.value.trim();
    if (!markdown) return;

    const existing = findMinutes(person.id, projectId, week);
    if (existing) {
      existing.markdown = markdown;
      existing.updatedAt = new Date().toISOString();
      return;
    }

    state.minutes.push({
      id: uid("minutes"),
      personId: person.id,
      projectId,
      week,
      markdown,
      updatedAt: new Date().toISOString(),
    });
  }

  async function startPushToTalk() {
    if (!speechState.available || speechState.isRecording || speechState.isTranscribing) return;
    try {
      speechState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      speechState.chunks = [];
      const mimeType = getSupportedRecordingMimeType();
      speechState.mediaRecorder = mimeType ? new MediaRecorder(speechState.stream, { mimeType }) : new MediaRecorder(speechState.stream);
      speechState.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          speechState.chunks.push(event.data);
        }
      });
      speechState.mediaRecorder.addEventListener("stop", onRecordingStopped);
      speechState.mediaRecorder.start(250);
      speechState.startedAtMs = Date.now();
      speechState.isRecording = true;
      clearSpeechStopTimer();
      speechState.stopFallbackTimer = setTimeout(() => {
        stopPushToTalk();
      }, 30000);
      el.pushToTalkButton.classList.add("recording");
      el.pushToTalkButton.textContent = "Release to stop";
      setSpeechStatus("Recording...");
    } catch (error) {
      setSpeechStatus(`Microphone error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  function stopPushToTalk() {
    if (!speechState.isRecording || !speechState.mediaRecorder) return;
    clearSpeechStopTimer();
    if (speechState.mediaRecorder.state !== "inactive") {
      speechState.mediaRecorder.requestData();
      speechState.mediaRecorder.stop();
    }
    speechState.isRecording = false;
    el.pushToTalkButton.classList.remove("recording");
    el.pushToTalkButton.textContent = "Hold to talk";
    el.pushToTalkButton.disabled = true;
    speechState.isTranscribing = true;
    setSpeechStatus("Transcribing...");
  }

  async function onRecordingStopped() {
    try {
      const mimeType = speechState.mediaRecorder && speechState.mediaRecorder.mimeType
        ? speechState.mediaRecorder.mimeType
        : "audio/webm";
      const durationMs = Date.now() - speechState.startedAtMs;
      const totalBytes = speechState.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      if (totalBytes === 0 || durationMs < 200) {
        setSpeechStatus("No audio captured. Hold the button while speaking.");
        return;
      }
      const audioBlob = new Blob(speechState.chunks, { type: mimeType });
      const transcript = await transcribeWithMistral(audioBlob, mimeType);
      if (!transcript) {
        setSpeechStatus("No speech detected. Try speaking closer to the mic.");
        return;
      }
      insertTranscript(transcript);
      setSpeechStatus("Transcription added.");
    } catch (error) {
      setSpeechStatus(formatSpeechError(error));
    } finally {
      clearSpeechStopTimer();
      if (speechState.stream) {
        speechState.stream.getTracks().forEach((track) => track.stop());
      }
      speechState.stream = null;
      speechState.mediaRecorder = null;
      speechState.chunks = [];
      speechState.isTranscribing = false;
      speechState.startedAtMs = 0;
      el.pushToTalkButton.disabled = false;
    }
  }

  async function transcribeWithMistral(audioBlob, mimeType) {
    const formData = new FormData();
    const fileExt = mimeType.includes("ogg") ? "ogg" : "webm";
    const audioFile = new File([audioBlob], `meeting-note.${fileExt}`, { type: mimeType });
    formData.append("file", audioFile);
    formData.append("model", speechState.model);

    const response = await fetch(speechState.endpoint, {
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
    const transcript = getTranscriptFromPayload(payload);
    if (!transcript) {
      return "";
    }
    return transcript;
  }

  function insertTranscript(transcript) {
    const cursorStart = el.editor.selectionStart;
    const cursorEnd = el.editor.selectionEnd;
    const current = el.editor.value;
    const prefix = current && cursorStart > 0 && current[cursorStart - 1] !== "\n" ? "\n" : "";
    const insertion = `${prefix}${transcript}\n`;
    el.editor.value = `${current.slice(0, cursorStart)}${insertion}${current.slice(cursorEnd)}`;
    const nextCursor = cursorStart + insertion.length;
    el.editor.selectionStart = nextCursor;
    el.editor.selectionEnd = nextCursor;
    el.preview.innerHTML = renderMarkdown(el.editor.value);
  }

  function setSpeechStatus(message) {
    el.speechStatus.textContent = message;
  }

  function getSupportedRecordingMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return "";
    }
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
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
    if (speechState.stopFallbackTimer) {
      clearTimeout(speechState.stopFallbackTimer);
      speechState.stopFallbackTimer = null;
    }
  }

  function buildSpeechHeaders() {
    const headers = {};
    const auth = toBearerToken(speechState.apiKey);
    if (auth) {
      headers.Authorization = auth;
    }
    return headers;
  }

  function toBearerToken(value) {
    if (!value || typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed;
    return `Bearer ${trimmed}`;
  }


  function generateReportText(week) {
    const rows = state.minutes.filter((entry) => entry.week === week);
    if (!rows.length) {
      return `Weekly Progress Report (${week})\n\nNo updates available for this week.`;
    }

    const lines = [`Weekly Progress Report (${week})`, "", "Hello team,", "", "Here is this week's progress summary.", ""];
    state.people.forEach((person) => {
      const personRows = rows.filter((row) => row.personId === person.id);
      if (!personRows.length) return;
      lines.push(`## ${person.name}`);

      const projectsWithGeneral = [{ id: "", name: "General Updates" }, ...state.projects];
      projectsWithGeneral.forEach((project) => {
        const group = personRows.filter((row) => row.projectId === project.id);
        if (!group.length) return;
        lines.push(`### ${project.name}`);
        group.forEach((row) => {
          const lastWeek = shiftWeek(week, -7);
          const lastEntry = findMinutes(person.id, project.id, lastWeek);
          const currentText = stripMarkdownForEmail(row.markdown) || "-";
          const lastText = lastEntry ? stripMarkdownForEmail(lastEntry.markdown) : "-";
          lines.push("| Current week | Last week |");
          lines.push("| --- | --- |");
          lines.push(`| ${currentText.replace(/\n/g, "<br>")} | ${lastText.replace(/\n/g, "<br>")} |`);
          lines.push("");
        });
      });
    });

    lines.push("Best regards,");
    lines.push("Team");
    return lines.join("\n");
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
            `<table class="report-table">
              <thead>
                <tr><th>Current week</th><th>Last week</th></tr>
              </thead>
              <tbody>
                <tr><td>${currentHtml}</td><td>${lastHtml}</td></tr>
              </tbody>
            </table>`
          );
        });
      });
    });

    html.push("<p>Best regards,<br>Team</p>");
    return html.join("");
  }

  function findMinutes(personId, projectId, week) {
    return state.minutes.find(
      (entry) => entry.personId === personId && entry.projectId === projectId && entry.week === week
    );
  }

  function selectedPerson() {
    return state.people.find((person) => person.id === state.ui.selectedPersonId) || null;
  }

  function renderMarkdown(markdown) {
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

    if (inList) {
      html.push("</ul>");
    }

    return html.join("");
  }

  function stripMarkdownForEmail(markdown) {
    return markdown
      .replace(/^###?\s+/gm, "")
      .replace(/^-\s+/gm, "• ")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/`/g, "");
  }

  function htmlToEmailText(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container.innerText.replace(/\n{3,}/g, "\n\n").trim();
  }

  function getMistralApiKey() {
    const keyFromStorage = localStorage.getItem(MISTRAL_API_KEY_STORAGE_KEY);
    if (keyFromStorage && keyFromStorage.trim()) {
      return keyFromStorage.trim();
    }
    return "";
  }

  function getMistralSpeechModel() {
    const model = localStorage.getItem(MISTRAL_MODEL_STORAGE_KEY);
    if (model && model.trim()) {
      return model.trim();
    }
    return DEFAULT_MISTRAL_SPEECH_MODEL;
  }

  function getMistralTranscriptionEndpoint() {
    const endpoint = localStorage.getItem(MISTRAL_ENDPOINT_STORAGE_KEY);
    if (endpoint && endpoint.trim()) {
      return endpoint.trim();
    }
    return MISTRAL_TRANSCRIPTION_ENDPOINT;
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

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(initialState);
    try {
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(initialState),
        ...parsed,
        ui: { ...initialState.ui, ...(parsed.ui || {}) },
      };
    } catch {
      return structuredClone(initialState);
    }
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function mondayOf(date) {
    const d = new Date(date);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d.toISOString().slice(0, 10);
  }

  function shiftWeek(yyyyMmDd, deltaDays) {
    const d = new Date(`${yyyyMmDd}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }

  function ensureValidSelection() {
    const personExists = state.people.some((person) => person.id === state.ui.selectedPersonId);
    if (!personExists) {
      state.ui.selectedPersonId = state.people[0] ? state.people[0].id : "";
    }

    const projectExists = state.projects.some((project) => project.id === state.ui.selectedProjectId);
    if (!projectExists) {
      state.ui.selectedProjectId = "";
    }
  }

  function editPerson(personId) {
    const person = state.people.find((entry) => entry.id === personId);
    if (!person) return;
    const nextName = window.prompt("Edit person name:", person.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    person.name = trimmed;
    persistAndRender();
  }

  function deletePerson(personId) {
    const person = state.people.find((entry) => entry.id === personId);
    if (!person) return;
    const shouldDelete = window.confirm(`Delete ${person.name} and their minutes?`);
    if (!shouldDelete) return;
    state.people = state.people.filter((entry) => entry.id !== personId);
    state.minutes = state.minutes.filter((entry) => entry.personId !== personId);
    ensureValidSelection();
    persistAndRender();
  }

  function editProject(projectId) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const nextName = window.prompt("Edit project name:", project.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    project.name = trimmed;
    persistAndRender();
  }

  function deleteProject(projectId) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const shouldDelete = window.confirm(`Delete project ${project.name}?`);
    if (!shouldDelete) return;

    state.projects = state.projects.filter((entry) => entry.id !== projectId);
    state.people.forEach((person) => {
      person.projectIds = person.projectIds.filter((id) => id !== projectId);
    });
    state.minutes = state.minutes.filter((entry) => entry.projectId !== projectId);
    ensureValidSelection();
    persistAndRender();
  }
})();
