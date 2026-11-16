/* Private knowledge base: one Firestore markdown doc at private/knowledge. */
(function (global) {
    const DOC_LIMIT = 1048576;
    const DOC_OVERHEAD = 128;
    const DRAFT_KEY = "naedmas.kb.draft.v1";
    const AUTOSAVE_MS = 800;
    const PREVIEW_MS = 160;

    document.addEventListener("DOMContentLoaded", function () {
        if (typeof marked !== "undefined") {
            marked.setOptions({ gfm: true, breaks: true });
        }

        let db = firebase.firestore();
        let notesRef = db.collection("private").doc("knowledge");
        let runTransaction = function (fn) {
            return db.runTransaction(fn);
        };

        let currentMarkdown = "";
        let currentUpdatedAt = null;
        let saving = false;
        let editing = false;
        let searchHits = [];
        let searchIndex = -1;
        let autosaveTimer = null;
        let previewTimer = null;
        let tocObserver = null;

        const lastSavedEl = document.getElementById("lastSaved");
        const errorBox = document.getElementById("errorBox");
        const viewPane = document.getElementById("viewPane");
        const editPane = document.getElementById("editPane");
        const viewActions = document.getElementById("viewActions");
        const editActions = document.getElementById("editActions");
        const emptyState = document.getElementById("emptyState");
        const rendered = document.getElementById("rendered");
        const editor = document.getElementById("editor");
        const editPreview = document.getElementById("editPreview");
        const editSplit = document.getElementById("editSplit");
        const previewToggle = document.getElementById("previewToggle");
        const saveBtn = document.getElementById("saveBtn");
        const sizeMeter = document.getElementById("sizeMeter");
        const sizeBar = document.getElementById("sizeBar");
        const sizeLabel = document.getElementById("sizeLabel");
        const toc = document.getElementById("kbToc");
        const tocNav = document.getElementById("tocNav");
        const tocToggle = document.getElementById("tocToggle");
        const kbView = document.getElementById("kbView");
        const searchInput = document.getElementById("searchInput");
        const searchCount = document.getElementById("searchCount");
        const draftBanner = document.getElementById("draftBanner");
        const draftBannerText = document.getElementById("draftBannerText");
        const conflictBanner = document.getElementById("conflictBanner");

        function $(id) {
            return document.getElementById(id);
        }

        function isDirty() {
            return editing && editor.value !== currentMarkdown;
        }

        function utf8Bytes(str) {
            return new TextEncoder().encode(str || "").length;
        }

        function estimatedDocSize(markdown) {
            return utf8Bytes(markdown) + DOC_OVERHEAD;
        }

        function formatBytes(n) {
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) {
                const kb = n / 1024;
                return (kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)) + " KB";
            }
            return (n / (1024 * 1024)).toFixed(2) + " MB";
        }

        function tsMillis(ts) {
            if (!ts) return 0;
            if (typeof ts.toMillis === "function") return ts.toMillis();
            if (typeof ts.toDate === "function") return ts.toDate().getTime();
            const n = new Date(ts).getTime();
            return Number.isNaN(n) ? 0 : n;
        }

        function timestampsEqual(a, b) {
            return tsMillis(a) === tsMillis(b);
        }

        function formatSaved(ts) {
            if (!ts) return "";
            const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
            if (Number.isNaN(date.getTime())) return "";
            return "Last saved " + date.toLocaleString("en-AU", {
                dateStyle: "medium",
                timeStyle: "short"
            });
        }

        function updateLastSaved() {
            lastSavedEl.textContent = formatSaved(currentUpdatedAt);
        }

        function showError(err, action) {
            const code = err && err.code ? String(err.code) : "";
            const message = err && err.message ? String(err.message) : String(err);
            const denied = code === "permission-denied" || /permission/i.test(message);
            let text = denied
                ? "Access denied. Firestore refused to " + (action || "load") + " these notes. You may not be signed in with the authorized account."
                : "Could not " + (action || "load") + " your notes.";
            if (message) text += " (" + (code ? code + ": " : "") + message + ")";
            errorBox.textContent = text;
            errorBox.classList.remove("hidden");
        }

        function hideError() {
            errorBox.classList.add("hidden");
            errorBox.textContent = "";
        }

        function slugify(text) {
            const s = String(text || "")
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9\s-]/g, "")
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "");
            return s || "section";
        }

        function addHeadingIds(root) {
            const used = new Set();
            const items = [];
            root.querySelectorAll("h1, h2, h3, h4").forEach(function (el) {
                const text = (el.textContent || "").trim();
                if (!text) return;
                let id = "kb-" + slugify(text);
                let n = 2;
                let candidate = id;
                while (used.has(candidate) || (document.getElementById(candidate) && document.getElementById(candidate) !== el)) {
                    candidate = id + "-" + n++;
                }
                used.add(candidate);
                el.id = candidate;
                items.push({ id: candidate, text: text, level: Number(el.tagName.charAt(1)) });
            });
            return items;
        }

        function renderMarkdown(markdown, root) {
            const raw = marked.parse(markdown || "", { async: false });
            root.innerHTML = DOMPurify.sanitize(raw);
            return addHeadingIds(root);
        }

        function buildToc(items) {
            tocNav.innerHTML = "";
            if (!items.length) {
                toc.classList.add("is-empty");
                const p = document.createElement("p");
                p.className = "kb-toc-empty";
                p.textContent = "No headings yet.";
                tocNav.appendChild(p);
                return;
            }
            toc.classList.remove("is-empty");
            items.forEach(function (item) {
                const a = document.createElement("a");
                a.href = "#" + encodeURIComponent(item.id).replace(/%20/g, "-");
                a.href = "#" + item.id;
                a.textContent = item.text;
                a.dataset.level = String(item.level);
                a.addEventListener("click", function (event) {
                    event.preventDefault();
                    const target = document.getElementById(item.id);
                    if (target) {
                        target.scrollIntoView({ block: "start" });
                        if (history.replaceState) history.replaceState(null, "", "#" + item.id);
                    }
                });
                tocNav.appendChild(a);
            });
            observeHeadings(items);
        }

        function observeHeadings(items) {
            if (tocObserver) {
                tocObserver.disconnect();
                tocObserver = null;
            }
            if (!items.length) return;
            const links = Array.from(tocNav.querySelectorAll("a"));
            tocObserver = new IntersectionObserver(function (entries) {
                const visible = entries
                    .filter(function (e) { return e.isIntersecting; })
                    .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
                if (!visible.length) return;
                const id = visible[0].target.id;
                links.forEach(function (link) {
                    link.classList.toggle("is-active", link.getAttribute("href") === "#" + id);
                });
            }, { rootMargin: "-10% 0px -70% 0px", threshold: 0 });
            items.forEach(function (item) {
                const el = document.getElementById(item.id);
                if (el) tocObserver.observe(el);
            });
        }

        function showEmpty() {
            rendered.innerHTML = "";
            emptyState.classList.remove("hidden");
            kbView.classList.add("is-empty");
            document.getElementById("kbTools").classList.add("hidden");
            buildToc([]);
            clearSearch();
        }

        function showDocument(markdown) {
            emptyState.classList.add("hidden");
            if (!markdown || !markdown.trim()) {
                showEmpty();
                return;
            }
            kbView.classList.remove("is-empty");
            document.getElementById("kbTools").classList.remove("hidden");
            const items = renderMarkdown(markdown, rendered);
            buildToc(items);
            if (searchInput.value.trim()) runSearch();
        }

        function updateSizeMeter() {
            const size = estimatedDocSize(editor.value);
            const ratio = Math.min(1, size / DOC_LIMIT);
            const pct = Math.round(ratio * 100);
            sizeBar.style.width = pct + "%";
            sizeLabel.textContent = formatBytes(size) + " of 1 MB";
            sizeMeter.classList.toggle("is-warn", size >= DOC_LIMIT * 0.8 && size < DOC_LIMIT);
            sizeMeter.classList.toggle("is-over", size >= DOC_LIMIT);
            if (size >= DOC_LIMIT) {
                sizeMeter.setAttribute("title", "This is over the 1 MB Firestore document limit and cannot be saved until it is smaller.");
            } else if (size >= DOC_LIMIT * 0.8) {
                sizeMeter.setAttribute("title", "Approaching the 1 MB Firestore document limit.");
            } else {
                sizeMeter.removeAttribute("title");
            }
        }

        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(function () {
                renderMarkdown(editor.value, editPreview);
            }, PREVIEW_MS);
        }

        function readDraft() {
            try {
                const raw = localStorage.getItem(DRAFT_KEY);
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (!data || typeof data.markdown !== "string") return null;
                return data;
            } catch (err) {
                return null;
            }
        }

        function writeDraft(markdown) {
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify({
                    markdown: markdown,
                    savedAt: Date.now(),
                    baseUpdatedAt: tsMillis(currentUpdatedAt)
                }));
            } catch (err) {
                /* quota or private mode — ignore */
            }
        }

        function clearDraft() {
            try {
                localStorage.removeItem(DRAFT_KEY);
            } catch (err) { /* ignore */ }
            draftBanner.classList.add("hidden");
        }

        function scheduleAutosave() {
            clearTimeout(autosaveTimer);
            autosaveTimer = setTimeout(function () {
                if (isDirty()) writeDraft(editor.value);
                else clearDraft();
            }, AUTOSAVE_MS);
        }

        function showDraftBanner(draft) {
            const when = draft && draft.savedAt
                ? new Date(draft.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })
                : "";
            draftBannerText.textContent = when
                ? "A local draft from " + when + " was found."
                : "A local draft was found.";
            draftBanner.classList.remove("hidden");
        }

        function maybeOfferDraft() {
            const draft = readDraft();
            if (!draft) {
                draftBanner.classList.add("hidden");
                return;
            }
            if (draft.markdown === currentMarkdown) {
                clearDraft();
                return;
            }
            showDraftBanner(draft);
        }

        function enterViewMode() {
            editing = false;
            clearTimeout(autosaveTimer);
            editPane.classList.add("hidden");
            viewPane.classList.remove("hidden");
            editActions.classList.add("hidden");
            viewActions.classList.remove("hidden");
            showDocument(currentMarkdown);
            updateLastSaved();
            if (previewToggle) {
                previewToggle.setAttribute("aria-pressed", "false");
                editSplit.classList.remove("is-preview");
                previewToggle.textContent = "Preview";
            }
        }

        function enterEditMode(initialText) {
            hideError();
            conflictBanner.classList.add("hidden");
            editing = true;
            editor.value = typeof initialText === "string" ? initialText : currentMarkdown;
            viewPane.classList.add("hidden");
            editPane.classList.remove("hidden");
            viewActions.classList.add("hidden");
            editActions.classList.remove("hidden");
            renderMarkdown(editor.value, editPreview);
            updateSizeMeter();
            editor.focus();
        }

        function confirmLeave() {
            if (!isDirty()) return true;
            return window.confirm("You have unsaved changes. Leave without saving?");
        }

        async function loadNotes() {
            hideError();
            conflictBanner.classList.add("hidden");
            try {
                const snap = await notesRef.get();
                if (!snap.exists) {
                    currentMarkdown = "";
                    currentUpdatedAt = null;
                } else {
                    const data = snap.data() || {};
                    currentMarkdown = typeof data.markdown === "string" ? data.markdown : "";
                    currentUpdatedAt = data.updatedAt || null;
                }
                enterViewMode();
                maybeOfferDraft();
            } catch (err) {
                currentMarkdown = "";
                currentUpdatedAt = null;
                emptyState.classList.add("hidden");
                rendered.innerHTML = "";
                kbView.classList.add("is-empty");
                viewActions.classList.add("hidden");
                editActions.classList.add("hidden");
                showError(err, "load");
            }
        }

        function applyLoaded(data, exists) {
            if (!exists) {
                currentMarkdown = "";
                currentUpdatedAt = null;
            } else {
                currentMarkdown = typeof data.markdown === "string" ? data.markdown : "";
                currentUpdatedAt = data.updatedAt || null;
            }
        }

        async function saveNotes(options) {
            const force = options && options.force;
            if (saving) return;
            const payload = editor.value;
            const size = estimatedDocSize(payload);
            if (size > DOC_LIMIT) {
                showError({ message: "These notes are over the 1 MB Firestore document limit. Shorten them before saving." }, "save");
                updateSizeMeter();
                return;
            }
            saving = true;
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving…";
            hideError();
            if (!force) conflictBanner.classList.add("hidden");
            try {
                await runTransaction(async function (tx) {
                    const snap = await tx.get(notesRef);
                    const serverUpdated = snap.exists ? ((snap.data() || {}).updatedAt || null) : null;
                    if (!force && !timestampsEqual(serverUpdated, currentUpdatedAt)) {
                        const err = new Error("conflict");
                        err.code = "kb-conflict";
                        throw err;
                    }
                    tx.set(notesRef, {
                        markdown: payload,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                });
                const snap = await notesRef.get();
                if (snap.exists) {
                    applyLoaded(snap.data() || {}, true);
                } else {
                    currentMarkdown = payload;
                    currentUpdatedAt = { toDate: function () { return new Date(); }, toMillis: function () { return Date.now(); } };
                }
                currentMarkdown = payload;
                clearDraft();
                conflictBanner.classList.add("hidden");
                enterViewMode();
            } catch (err) {
                if (err && (err.code === "kb-conflict" || err.message === "conflict")) {
                    conflictBanner.classList.remove("hidden");
                    conflictBanner.scrollIntoView({ block: "nearest" });
                } else {
                    showError(err, "save");
                }
            } finally {
                saving = false;
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
            }
        }

        async function reloadServerCopy() {
            hideError();
            try {
                const previous = editor.value;
                const snap = await notesRef.get();
                if (!snap.exists) applyLoaded({}, false);
                else applyLoaded(snap.data() || {}, true);
                conflictBanner.classList.add("hidden");
                if (previous !== currentMarkdown) writeDraft(previous);
                enterEditMode(currentMarkdown);
                const draft = readDraft();
                if (previous !== currentMarkdown && draft) {
                    const when = draft.savedAt
                        ? new Date(draft.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })
                        : "";
                    draftBannerText.textContent = when
                        ? "Your previous edits were kept as a local draft from " + when + "."
                        : "Your previous edits were kept as a local draft.";
                    draftBanner.classList.remove("hidden");
                }
            } catch (err) {
                showError(err, "load");
            }
        }

        function downloadBackup() {
            const text = editing ? editor.value : currentMarkdown;
            const now = new Date();
            const y = now.getFullYear();
            const m = String(now.getMonth() + 1).padStart(2, "0");
            const d = String(now.getDate()).padStart(2, "0");
            const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "knowledge-" + y + "-" + m + "-" + d + ".md";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }

        function clearSearch() {
            clearHighlights(rendered);
            searchHits = [];
            searchIndex = -1;
            searchCount.textContent = "";
        }

        function clearHighlights(root) {
            root.querySelectorAll("mark.kb-hit").forEach(function (mark) {
                const parent = mark.parentNode;
                if (!parent) return;
                parent.replaceChild(document.createTextNode(mark.textContent), mark);
                parent.normalize();
            });
        }

        function highlightSearch(root, query) {
            clearHighlights(root);
            const hits = [];
            const q = query.toLowerCase();
            if (!q) return hits;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(q)) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement && node.parentElement.closest("mark, script, style")) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            nodes.forEach(function (node) {
                const text = node.nodeValue;
                const lower = text.toLowerCase();
                const frag = document.createDocumentFragment();
                let i = 0;
                let idx;
                while ((idx = lower.indexOf(q, i)) !== -1) {
                    if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
                    const mark = document.createElement("mark");
                    mark.className = "kb-hit";
                    mark.textContent = text.slice(idx, idx + query.length);
                    frag.appendChild(mark);
                    hits.push(mark);
                    i = idx + q.length;
                }
                if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
                node.parentNode.replaceChild(frag, node);
            });
            return hits;
        }

        function setCurrentHit(index) {
            if (!searchHits.length) {
                searchCount.textContent = "No matches";
                return;
            }
            searchHits.forEach(function (el) { el.classList.remove("is-current"); });
            searchIndex = (index + searchHits.length) % searchHits.length;
            const current = searchHits[searchIndex];
            current.classList.add("is-current");
            current.scrollIntoView({ block: "center" });
            searchCount.textContent = (searchIndex + 1) + " of " + searchHits.length;
        }

        function runSearch() {
            const query = searchInput.value.trim();
            if (!query) {
                clearSearch();
                return;
            }
            searchHits = highlightSearch(rendered, query);
            if (!searchHits.length) {
                searchIndex = -1;
                searchCount.textContent = "No matches";
                return;
            }
            setCurrentHit(0);
        }

        $("editBtn").addEventListener("click", function () { enterEditMode(); });
        $("emptyEditBtn").addEventListener("click", function () { enterEditMode(); });
        $("cancelBtn").addEventListener("click", function () {
            const discarded = isDirty();
            const discardedText = editor.value;
            if (!confirmLeave()) return;
            clearTimeout(autosaveTimer);
            const draft = readDraft();
            if (discarded && draft && draft.markdown === discardedText) clearDraft();
            hideError();
            conflictBanner.classList.add("hidden");
            enterViewMode();
            maybeOfferDraft();
        });
        saveBtn.addEventListener("click", function () { saveNotes(); });
        $("backupBtn").addEventListener("click", downloadBackup);
        $("backupBtnEdit").addEventListener("click", downloadBackup);

        editor.addEventListener("input", function () {
            schedulePreview();
            updateSizeMeter();
            scheduleAutosave();
        });

        previewToggle.addEventListener("click", function () {
            const showPreview = !editSplit.classList.contains("is-preview");
            editSplit.classList.toggle("is-preview", showPreview);
            previewToggle.setAttribute("aria-pressed", showPreview ? "true" : "false");
            previewToggle.textContent = showPreview ? "Markdown" : "Preview";
            if (showPreview) renderMarkdown(editor.value, editPreview);
        });

        tocToggle.addEventListener("click", function () {
            const open = !toc.classList.contains("is-open");
            toc.classList.toggle("is-open", open);
            tocToggle.setAttribute("aria-expanded", open ? "true" : "false");
        });

        $("draftRestoreBtn").addEventListener("click", function () {
            const draft = readDraft();
            if (!draft) {
                draftBanner.classList.add("hidden");
                return;
            }
            enterEditMode(draft.markdown);
            draftBanner.classList.add("hidden");
        });
        $("draftDiscardBtn").addEventListener("click", function () {
            clearDraft();
        });
        $("conflictReloadBtn").addEventListener("click", function () {
            reloadServerCopy();
        });
        $("conflictOverwriteBtn").addEventListener("click", function () {
            saveNotes({ force: true });
        });

        let searchTimer = null;
        searchInput.addEventListener("input", function () {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(runSearch, 120);
        });
        searchInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault();
                if (!searchHits.length) runSearch();
                else setCurrentHit(event.shiftKey ? searchIndex - 1 : searchIndex + 1);
            }
        });
        $("searchPrev").addEventListener("click", function () {
            if (!searchHits.length) runSearch();
            else setCurrentHit(searchIndex - 1);
        });
        $("searchNext").addEventListener("click", function () {
            if (!searchHits.length) runSearch();
            else setCurrentHit(searchIndex + 1);
        });

        window.addEventListener("beforeunload", function (event) {
            if (isDirty()) {
                try { writeDraft(editor.value); } catch (err) { /* ignore */ }
                event.preventDefault();
                event.returnValue = "";
            }
        });

        document.addEventListener("click", function (event) {
            const logoutBtn = event.target.closest(".sidebar-foot .btn");
            if (logoutBtn && logoutBtn.textContent && /logout/i.test(logoutBtn.textContent)) {
                if (!confirmLeave()) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }
            const link = event.target.closest("a[href]");
            if (!link) return;
            const href = link.getAttribute("href") || "";
            if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("blob:")) return;
            if (link.hasAttribute("download")) return;
            if (link.target === "_blank") return;
            if (!isDirty()) return;
            if (!confirmLeave()) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);

        function loadDocument(markdown, updatedAt) {
            currentMarkdown = typeof markdown === "string" ? markdown : "";
            currentUpdatedAt = updatedAt || null;
            hideError();
            conflictBanner.classList.add("hidden");
            enterViewMode();
            maybeOfferDraft();
        }

        function installMock(initial) {
            const store = {
                exists: !!(initial && (initial.exists !== false) && (initial.markdown || initial.updatedAt)),
                markdown: (initial && initial.markdown) || "",
                updatedAt: (initial && initial.updatedAt) || null
            };
            if (initial && initial.exists === false) store.exists = false;
            notesRef = {
                get: async function () {
                    return {
                        exists: store.exists,
                        data: function () {
                            return { markdown: store.markdown, updatedAt: store.updatedAt };
                        }
                    };
                },
                set: async function (data) {
                    if (data.markdown !== undefined) store.markdown = data.markdown;
                    store.updatedAt = {
                        toMillis: function () { return Date.now(); },
                        toDate: function () { return new Date(); }
                    };
                    store.exists = true;
                }
            };
            runTransaction = async function (fn) {
                const tx = {
                    get: async function () { return notesRef.get(); },
                    set: async function (ref, data) { return notesRef.set(data); }
                };
                return fn(tx);
            };
            return store;
        }

        global.NaedmasKnowledge = {
            loadDocument: loadDocument,
            installMock: installMock,
            enterEditMode: function (text) { enterEditMode(text); },
            enterViewMode: enterViewMode,
            saveNotes: saveNotes,
            isDirty: isDirty,
            getState: function () {
                return {
                    editing: editing,
                    dirty: isDirty(),
                    currentMarkdown: currentMarkdown,
                    currentUpdatedAt: currentUpdatedAt,
                    editorValue: editor.value
                };
            }
        };

        NaedmasAuth.initAuth({
            onAuthorized: function () {
                loadNotes();
            }
        });
    });
})(window);
