/* Private knowledge base: articles at private/kb/articles/{id}.
   The legacy doc private/knowledge is read-only and is never written or deleted. */
(function (global) {
    const DOC_LIMIT = 1048576;
    const DOC_OVERHEAD = 256;
    const DRAFT_PREFIX = "naedmas.kb.draft.v2.";
    const DRAFT_LEGACY = "naedmas.kb.draft.v1";
    const LAST_KEY = "naedmas.kb.lastArticle";
    const AUTOSAVE_MS = 800;
    const PREVIEW_MS = 160;
    const VERSION_CAP = 20;
    const MIGRATED_ID = "codex";

    document.addEventListener("DOMContentLoaded", function () {
        if (typeof marked !== "undefined") marked.setOptions({ gfm: true, breaks: true });

        let FieldValue = firebase.firestore.FieldValue;
        let db = firebase.firestore();
        let runTransaction = function (fn) { return db.runTransaction(fn); };
        let batchFactory = function () { return db.batch(); };
        let articlesCol = db.collection("private").doc("kb").collection("articles");
        let kbMetaRef = db.collection("private").doc("kb");
        let legacyRef = db.collection("private").doc("knowledge");
        let persistStatus = "pending";

        let articles = [];
        let currentId = null;
        let currentMarkdown = "";
        let currentTitle = "";
        let currentTags = [];
        let currentUpdatedAt = null;
        let saving = false;
        let editing = false;
        let searchHits = [];
        let searchIndex = -1;
        let autosaveTimer = null;
        let previewTimer = null;
        let tocObserver = null;
        let articleFilter = "";
        let activeTag = "";
        let selectedVersion = null;

        const lastSavedEl = document.getElementById("lastSaved");
        const errorBox = document.getElementById("errorBox");
        const viewPane = document.getElementById("viewPane");
        const editPane = document.getElementById("editPane");
        const editMeta = document.getElementById("editMeta");
        const viewActions = document.getElementById("viewActions");
        const editActions = document.getElementById("editActions");
        const emptyState = document.getElementById("emptyState");
        const emptyStateText = document.getElementById("emptyStateText");
        const rendered = document.getElementById("rendered");
        const editor = document.getElementById("editor");
        const editPreview = document.getElementById("editPreview");
        const editSplit = document.getElementById("editSplit");
        const previewToggle = document.getElementById("previewToggle");
        const previewToggleSticky = document.getElementById("previewToggleSticky");
        const saveBtn = document.getElementById("saveBtn");
        const sizeMeter = document.getElementById("sizeMeter");
        const sizeBar = document.getElementById("sizeBar");
        const sizeLabel = document.getElementById("sizeLabel");
        const stickySize = document.getElementById("stickySize");
        const toc = document.getElementById("kbToc");
        const tocNav = document.getElementById("tocNav");
        const tocToggle = document.getElementById("tocToggle");
        const kbView = document.getElementById("kbView");
        const searchInput = document.getElementById("searchInput");
        const searchCount = document.getElementById("searchCount");
        const draftBanner = document.getElementById("draftBanner");
        const draftBannerText = document.getElementById("draftBannerText");
        const conflictBanner = document.getElementById("conflictBanner");
        const articleTitleEl = document.getElementById("articleTitle");
        const articleTagsEl = document.getElementById("articleTags");
        const titleInput = document.getElementById("titleInput");
        const tagInput = document.getElementById("tagInput");
        const articleList = document.getElementById("articleList");
        const articleSearch = document.getElementById("articleSearch");
        const tagFilters = document.getElementById("tagFilters");
        const kbRail = document.getElementById("kbRail");
        const railToggle = document.getElementById("railToggle");
        const backlinks = document.getElementById("backlinks");
        const backlinkList = document.getElementById("backlinkList");
        const wikiPicker = document.getElementById("wikiPicker");
        const historyPanel = document.getElementById("historyPanel");
        const historyBackdrop = document.getElementById("historyBackdrop");
        const historyList = document.getElementById("historyList");
        const historyContent = document.getElementById("historyContent");
        const historyEmpty = document.getElementById("historyEmpty");
        const historyActions = document.getElementById("historyActions");

        function $(id) { return document.getElementById(id); }
        function articleRef(id) { return articlesCol.doc(id); }
        function versionsCol(id) { return articleRef(id).collection("versions"); }
        function currentArticle() { return articles.find(function (a) { return a.id === currentId; }) || null; }
        function isDirty() {
            if (!editing) return false;
            return editor.value !== currentMarkdown
                || titleInput.value.trim() !== currentTitle
                || normalizeTags(tagInput.value).join("\n") !== currentTags.join("\n");
        }
        function utf8Bytes(str) { return new TextEncoder().encode(str || "").length; }
        function estimatedDocSize(markdown, title, tags) {
            return utf8Bytes(markdown || "") + utf8Bytes(title || "") + utf8Bytes((tags || []).join(",")) + DOC_OVERHEAD;
        }
        function formatBytes(n) {
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) { const kb = n / 1024; return (kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)) + " KB"; }
            return (n / (1024 * 1024)).toFixed(2) + " MB";
        }
        function tsMillis(ts) {
            if (!ts) return 0;
            if (typeof ts.toMillis === "function") return ts.toMillis();
            if (typeof ts.toDate === "function") return ts.toDate().getTime();
            if (typeof ts.seconds === "number") return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6);
            const n = new Date(ts).getTime();
            return Number.isNaN(n) ? 0 : n;
        }
        function tsDate(ts) {
            const ms = tsMillis(ts);
            return ms ? new Date(ms) : null;
        }
        function timestampsEqual(a, b) { return tsMillis(a) === tsMillis(b); }
        function formatSaved(ts) {
            const date = tsDate(ts);
            if (!date) return "";
            return "Last saved " + date.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
        }
        function formatVersion(ts) {
            const date = tsDate(ts);
            if (!date) return "Unknown time";
            return date.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
        }
        function updateLastSaved() { lastSavedEl.textContent = formatSaved(currentUpdatedAt); }
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
        function hideError() { errorBox.classList.add("hidden"); errorBox.textContent = ""; }
        function slugify(text) {
            const s = String(text || "").toLowerCase().trim()
                .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
            return s || "article";
        }
        function uniqueSlug(base, ignoreId) {
            let slug = slugify(base), n = 2, candidate = slug;
            while (articles.some(function (a) { return a.slug === candidate && a.id !== ignoreId; })) candidate = slug + "-" + n++;
            return candidate;
        }
        function normalizeTags(value) {
            const src = Array.isArray(value) ? value : String(value || "").split(/[,;]/);
            const seen = {}, out = [];
            src.forEach(function (t) {
                const tag = String(t || "").trim().toLowerCase();
                if (!tag || seen[tag]) return;
                seen[tag] = true; out.push(tag);
            });
            return out;
        }
        function stampNow() {
            const n = Date.now();
            return { toMillis: function () { return n; }, toDate: function () { return new Date(n); } };
        }
        function mapArticle(id, data) {
            data = data || {};
            return {
                id: id,
                title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Untitled",
                slug: typeof data.slug === "string" && data.slug ? data.slug : slugify(data.title || id),
                tags: normalizeTags(data.tags || []),
                aliases: Array.isArray(data.aliases) ? data.aliases.filter(function (a) { return typeof a === "string"; }) : [],
                markdown: typeof data.markdown === "string" ? data.markdown : "",
                createdAt: data.createdAt || null,
                updatedAt: data.updatedAt || null
            };
        }
        function resolveArticle(target) {
            const q = String(target || "").trim().toLowerCase();
            if (!q) return null;
            return articles.find(function (a) {
                if (a.id === target || a.slug.toLowerCase() === q || a.title.toLowerCase() === q) return true;
                return (a.aliases || []).some(function (al) { return al.toLowerCase() === q; });
            }) || null;
        }
        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, function (c) {
                return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
            });
        }
        function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, " "); }
        function rewriteWikiLinks(markdown) {
            return String(markdown || "").replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, function (full, target, label) {
                const name = String(target || "").trim();
                const text = (label || name).trim() || name;
                const found = resolveArticle(name);
                if (found) {
                    return '<a class="kb-wiki-link" href="?a=' + encodeURIComponent(found.slug) + '" data-article="' + found.id + '">' + escapeHtml(text) + "</a>";
                }
                return '<a class="kb-wiki-link is-missing" href="#" data-create="' + escapeAttr(name) + '">' + escapeHtml(text) + "</a>";
            });
        }

        function addHeadingIds(root) {
            const used = new Set();
            const items = [];
            root.querySelectorAll("h1, h2, h3, h4").forEach(function (el) {
                const text = (el.textContent || "").trim();
                if (!text) return;
                let id = "kb-" + slugify(text), n = 2, candidate = id;
                while (used.has(candidate) || (document.getElementById(candidate) && document.getElementById(candidate) !== el)) candidate = id + "-" + n++;
                used.add(candidate); el.id = candidate;
                items.push({ id: candidate, text: text, level: Number(el.tagName.charAt(1)) });
            });
            return items;
        }
        function renderMarkdown(markdown, root) {
            const raw = marked.parse(rewriteWikiLinks(markdown || ""), { async: false });
            root.innerHTML = DOMPurify.sanitize(raw, { ADD_ATTR: ["data-create", "data-article"] });
            return addHeadingIds(root);
        }
        function buildToc(items) {
            tocNav.innerHTML = "";
            if (!items.length) {
                toc.classList.add("is-empty");
                const p = document.createElement("p"); p.className = "kb-toc-empty"; p.textContent = "No headings yet.";
                tocNav.appendChild(p); return;
            }
            toc.classList.remove("is-empty");
            items.forEach(function (item) {
                const a = document.createElement("a");
                a.href = "#" + item.id; a.textContent = item.text; a.dataset.level = String(item.level);
                a.addEventListener("click", function (event) {
                    event.preventDefault();
                    const target = document.getElementById(item.id);
                    if (target) target.scrollIntoView({ block: "start" });
                });
                tocNav.appendChild(a);
            });
            observeHeadings(items);
        }
        function observeHeadings(items) {
            if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
            if (!items.length) return;
            const links = Array.from(tocNav.querySelectorAll("a"));
            tocObserver = new IntersectionObserver(function (entries) {
                const visible = entries.filter(function (e) { return e.isIntersecting; })
                    .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
                if (!visible.length) return;
                const id = visible[0].target.id;
                links.forEach(function (link) { link.classList.toggle("is-active", link.getAttribute("href") === "#" + id); });
            }, { rootMargin: "-10% 0px -70% 0px", threshold: 0 });
            items.forEach(function (item) { const el = document.getElementById(item.id); if (el) tocObserver.observe(el); });
        }
        function findWikiTargets(markdown) {
            const out = [];
            String(markdown || "").replace(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g, function (_, target) { out.push(String(target || "").trim()); return _; });
            return out;
        }
        function renderBacklinks() {
            backlinkList.innerHTML = "";
            if (!currentId) { backlinks.classList.add("hidden"); return; }
            const art = currentArticle();
            const names = [art.title, art.slug].concat(art.aliases || []);
            const hits = articles.filter(function (other) {
                if (other.id === currentId) return false;
                return findWikiTargets(other.markdown).some(function (t) {
                    const q = t.toLowerCase();
                    return names.some(function (n) { return String(n).toLowerCase() === q; }) || t === currentId;
                });
            });
            if (!hits.length) { backlinks.classList.add("hidden"); return; }
            hits.forEach(function (other) {
                const a = document.createElement("a");
                a.href = "?a=" + encodeURIComponent(other.slug);
                a.className = "kb-wiki-link"; a.dataset.article = other.id; a.textContent = other.title;
                backlinkList.appendChild(a);
            });
            backlinks.classList.remove("hidden");
        }
        function showEmpty(message) {
            rendered.innerHTML = "";
            emptyStateText.textContent = message || "No articles yet";
            emptyState.classList.remove("hidden");
            kbView.classList.add("is-empty");
            $("kbTools").classList.add("hidden");
            backlinks.classList.add("hidden");
            buildToc([]); clearSearch();
        }
        function showDocument(markdown) {
            emptyState.classList.add("hidden");
            if (!currentId) { showEmpty("No articles yet"); return; }
            if (!markdown || !markdown.trim()) {
                emptyStateText.textContent = "This article is empty";
                emptyState.classList.remove("hidden");
                $("emptyEditBtn").textContent = "Edit";
                kbView.classList.add("is-empty");
                $("kbTools").classList.add("hidden");
                buildToc([]); renderBacklinks(); return;
            }
            $("emptyEditBtn").textContent = "New article";
            kbView.classList.remove("is-empty");
            $("kbTools").classList.remove("hidden");
            buildToc(renderMarkdown(markdown, rendered));
            renderBacklinks();
            if (searchInput.value.trim()) runSearch();
        }
        function updateTitleChrome() {
            articleTitleEl.textContent = currentTitle || "Knowledge Base";
            document.title = (currentTitle ? currentTitle + " • " : "") + "Knowledge Base • naedmas";
            articleTagsEl.innerHTML = "";
            currentTags.forEach(function (tag) {
                const b = document.createElement("button");
                b.type = "button"; b.className = "kb-tag" + (activeTag === tag ? " is-active" : "");
                b.textContent = tag;
                b.addEventListener("click", function () { setActiveTag(activeTag === tag ? "" : tag); });
                articleTagsEl.appendChild(b);
            });
        }
        function updateSizeMeter() {
            const tags = normalizeTags(tagInput.value);
            const size = estimatedDocSize(editor.value, titleInput.value, tags);
            sizeBar.style.width = Math.round(Math.min(1, size / DOC_LIMIT) * 100) + "%";
            const label = formatBytes(size) + " of 1 MB";
            sizeLabel.textContent = label;
            if (stickySize) stickySize.textContent = label;
            sizeMeter.classList.toggle("is-warn", size >= DOC_LIMIT * 0.8 && size < DOC_LIMIT);
            sizeMeter.classList.toggle("is-over", size >= DOC_LIMIT);
        }
        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(function () { renderMarkdown(editor.value, editPreview); }, PREVIEW_MS);
        }
        function draftKey(id) { return DRAFT_PREFIX + (id || "none"); }
        function readDraft(id) {
            try {
                const raw = localStorage.getItem(draftKey(id));
                if (!raw) return null;
                const data = JSON.parse(raw);
                return data && typeof data.markdown === "string" ? data : null;
            } catch (err) { return null; }
        }
        function writeDraft(id, payload) {
            try {
                localStorage.setItem(draftKey(id), JSON.stringify({
                    markdown: payload.markdown, title: payload.title || "", tags: payload.tags || [],
                    savedAt: Date.now(), baseUpdatedAt: tsMillis(currentUpdatedAt)
                }));
            } catch (err) { /* ignore */ }
        }
        function clearDraft(id) {
            try { localStorage.removeItem(draftKey(id)); } catch (err) { /* ignore */ }
            draftBanner.classList.add("hidden");
        }
        function scheduleAutosave() {
            clearTimeout(autosaveTimer);
            autosaveTimer = setTimeout(function () {
                if (!currentId) return;
                if (isDirty()) writeDraft(currentId, { markdown: editor.value, title: titleInput.value, tags: normalizeTags(tagInput.value) });
                else clearDraft(currentId);
            }, AUTOSAVE_MS);
        }
        function showDraftBanner(draft, prefix) {
            const when = draft && draft.savedAt ? new Date(draft.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "";
            const lead = prefix || "A local draft";
            draftBannerText.textContent = when ? lead + " from " + when + " was found." : lead + " was found.";
            draftBanner.classList.remove("hidden");
        }
        function maybeOfferDraft() {
            if (!currentId) { draftBanner.classList.add("hidden"); return; }
            const draft = readDraft(currentId);
            if (!draft) { draftBanner.classList.add("hidden"); return; }
            const same = draft.markdown === currentMarkdown && (draft.title || currentTitle) === currentTitle
                && normalizeTags(draft.tags || []).join("\n") === currentTags.join("\n");
            if (same) { clearDraft(currentId); return; }
            showDraftBanner(draft);
        }
        function setPreviewMode(showPreview) {
            editSplit.classList.toggle("is-preview", showPreview);
            [previewToggle, previewToggleSticky].forEach(function (btn) {
                if (!btn) return;
                btn.setAttribute("aria-pressed", showPreview ? "true" : "false");
                btn.textContent = showPreview ? "Markdown" : "Preview";
            });
            if (showPreview) renderMarkdown(editor.value, editPreview);
        }
        function enterViewMode() {
            editing = false;
            document.body.classList.remove("kb-editing");
            clearTimeout(autosaveTimer);
            editPane.classList.add("hidden"); editMeta.classList.add("hidden");
            viewPane.classList.remove("hidden");
            editActions.classList.add("hidden"); viewActions.classList.remove("hidden");
            wikiPicker.classList.add("hidden"); wikiPicker.hidden = true;
            setPreviewMode(false); updateTitleChrome(); showDocument(currentMarkdown); updateLastSaved(); renderArticleList();
        }
        function enterEditMode(seed) {
            if (!currentId) return;
            hideError(); conflictBanner.classList.add("hidden");
            editing = true; document.body.classList.add("kb-editing");
            editor.value = seed && typeof seed.markdown === "string" ? seed.markdown : currentMarkdown;
            titleInput.value = seed && typeof seed.title === "string" ? seed.title : currentTitle;
            tagInput.value = (seed && seed.tags ? seed.tags : currentTags).join(", ");
            viewPane.classList.add("hidden");
            editPane.classList.remove("hidden"); editMeta.classList.remove("hidden");
            viewActions.classList.add("hidden"); editActions.classList.remove("hidden");
            renderMarkdown(editor.value, editPreview); updateSizeMeter(); editor.focus();
        }
        function confirmLeave() { return isDirty() ? window.confirm("You have unsaved changes. Leave without saving?") : true; }
        function adoptArticle(art) {
            currentId = art ? art.id : null;
            currentMarkdown = art ? art.markdown : "";
            currentTitle = art ? art.title : "";
            currentTags = art ? art.tags.slice() : [];
            currentUpdatedAt = art ? art.updatedAt : null;
            if (art) {
                try { localStorage.setItem(LAST_KEY, art.id); } catch (err) { /* ignore */ }
                const url = new URL(window.location.href);
                if (url.searchParams.get("a") !== art.slug) {
                    url.searchParams.set("a", art.slug);
                    history.replaceState(null, "", url.pathname + url.search);
                }
            }
        }
        async function loadArticleIndex() {
            const snap = await articlesCol.get();
            articles = [];
            snap.forEach(function (doc) { articles.push(mapArticle(doc.id, doc.data())); });
            sortArticles();
        }
        function sortArticles() { articles.sort(function (a, b) { return a.title.localeCompare(b.title, "en", { sensitivity: "base" }); }); }
        async function enableOffline() {
            if (!db || typeof db.enablePersistence !== "function") { persistStatus = "unavailable"; return; }
            try {
                await db.enablePersistence({ synchronizeTabs: true });
                persistStatus = "enabled";
            } catch (err) {
                const code = err && err.code ? err.code : "";
                if (code === "failed-precondition") persistStatus = "enabled-elsewhere";
                else if (code === "unimplemented") persistStatus = "unimplemented";
                else persistStatus = code || "error";
            }
        }
        async function migrateIfNeeded() {
            const existing = await articlesCol.limit(2).get();
            if (!existing.empty) return { migrated: false, reason: "articles-exist" };
            const meta = await kbMetaRef.get();
            if (meta.exists && meta.data() && meta.data().legacyMigrated) return { migrated: false, reason: "already-migrated" };
            const legacy = await legacyRef.get();
            const legacyData = legacy.exists ? (legacy.data() || {}) : {};
            const markdown = typeof legacyData.markdown === "string" ? legacyData.markdown : "";
            await runTransaction(async function (tx) {
                const latestMeta = await tx.get(kbMetaRef);
                if (latestMeta.exists && latestMeta.data() && latestMeta.data().legacyMigrated) return;
                const dest = articleRef(MIGRATED_ID);
                const destSnap = await tx.get(dest);
                tx.set(kbMetaRef, { legacyMigrated: true, migratedAt: FieldValue.serverTimestamp() }, { merge: true });
                if (!destSnap.exists && markdown.trim()) {
                    tx.set(dest, {
                        title: "Codex", slug: "codex", tags: [], aliases: [], markdown: markdown,
                        createdAt: legacyData.updatedAt || FieldValue.serverTimestamp(),
                        updatedAt: legacyData.updatedAt || FieldValue.serverTimestamp()
                    });
                }
            });
            const created = markdown.trim() ? await articleRef(MIGRATED_ID).get() : { exists: false };
            if (created.exists) {
                try {
                    const legacyDraft = localStorage.getItem(DRAFT_LEGACY);
                    if (legacyDraft && !localStorage.getItem(draftKey(MIGRATED_ID))) {
                        const data = JSON.parse(legacyDraft);
                        if (data && typeof data.markdown === "string" && data.markdown !== markdown) {
                            localStorage.setItem(draftKey(MIGRATED_ID), JSON.stringify(data));
                        }
                    }
                } catch (err) { /* ignore */ }
                return { migrated: true, id: MIGRATED_ID };
            }
            return { migrated: false, reason: "no-legacy-content" };
        }
        async function start() {
            hideError();
            await enableOffline();
            await migrateIfNeeded();
            await loadArticleIndex();
            const wanted = new URLSearchParams(window.location.search).get("a");
            let last = null;
            try { last = localStorage.getItem(LAST_KEY); } catch (err) { last = null; }
            let art = wanted ? resolveArticle(wanted) : null;
            if (!art && last) art = articles.find(function (a) { return a.id === last; }) || null;
            if (!art) art = articles[0] || null;
            if (art) openArticle(art.id, { skipLeave: true });
            else { adoptArticle(null); enterViewMode(); showEmpty("No articles yet"); }
            renderArticleList();
        }
        function openArticle(id, options) {
            if (!(options && options.skipLeave) && !confirmLeave()) return false;
            const art = articles.find(function (a) { return a.id === id; });
            if (!art) return false;
            if (editing && currentId && currentId !== id) clearTimeout(autosaveTimer);
            adoptArticle(art); enterViewMode(); maybeOfferDraft();
            document.body.classList.remove("kb-rail-open");
            if (railToggle) railToggle.setAttribute("aria-expanded", "false");
            return true;
        }

        function renderArticleList() {
            const q = articleFilter.trim().toLowerCase();
            articleList.innerHTML = "";
            const visible = articles.filter(function (a) {
                if (activeTag && a.tags.indexOf(activeTag) === -1) return false;
                if (!q) return true;
                return (a.title + " " + a.slug + " " + a.tags.join(" ")).toLowerCase().indexOf(q) !== -1;
            });
            visible.forEach(function (a) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "kb-article-item" + (a.id === currentId ? " is-active" : "");
                btn.setAttribute("aria-current", a.id === currentId ? "page" : "false");
                const title = document.createElement("span"); title.className = "kb-article-item-title"; title.textContent = a.title;
                btn.appendChild(title);
                if (a.tags.length) {
                    const tags = document.createElement("span"); tags.className = "kb-article-item-tags"; tags.textContent = a.tags.join(", ");
                    btn.appendChild(tags);
                }
                btn.addEventListener("click", function () { openArticle(a.id); });
                articleList.appendChild(btn);
            });
            if (!visible.length) {
                const p = document.createElement("p"); p.className = "kb-rail-empty";
                p.textContent = articles.length ? "No matching articles." : "No articles yet.";
                articleList.appendChild(p);
            }
            renderTagFilters();
            if (railToggle) railToggle.textContent = "Articles" + (articles.length ? " (" + articles.length + ")" : "");
        }
        function renderTagFilters() {
            const tags = [];
            articles.forEach(function (a) { a.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); }); });
            tags.sort();
            tagFilters.innerHTML = "";
            if (!tags.length) { tagFilters.hidden = true; return; }
            tagFilters.hidden = false;
            tags.forEach(function (tag) {
                const b = document.createElement("button");
                b.type = "button"; b.className = "kb-tag" + (activeTag === tag ? " is-active" : "");
                b.textContent = tag;
                b.addEventListener("click", function () { setActiveTag(activeTag === tag ? "" : tag); });
                tagFilters.appendChild(b);
            });
        }
        function setActiveTag(tag) { activeTag = tag || ""; renderArticleList(); updateTitleChrome(); }

        async function createArticle(title, markdown) {
            const name = String(title || "").trim() || "Untitled";
            const ref = articlesCol.doc();
            const payload = {
                title: name, slug: uniqueSlug(name), tags: [], aliases: [],
                markdown: typeof markdown === "string" ? markdown : "",
                createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
            };
            await ref.set(payload);
            const snap = await ref.get();
            const art = mapArticle(ref.id, snap.exists ? snap.data() : payload);
            if (!art.updatedAt) art.updatedAt = stampNow();
            articles.push(art); sortArticles(); return art;
        }
        async function promptNewArticle(presetTitle, presetMarkdown, skipPrompt) {
            if (!confirmLeave()) return null;
            let name = presetTitle;
            if (!skipPrompt) {
                const typed = window.prompt("Title for the new article:", presetTitle || "");
                if (typed === null) return null;
                name = typed;
            }
            const art = await createArticle(name, presetMarkdown || "");
            openArticle(art.id, { skipLeave: true });
            if (!presetMarkdown) enterEditMode();
            return art;
        }
        async function renameArticle() {
            if (!currentId || !confirmLeave()) return;
            const next = window.prompt("Rename article:", currentTitle);
            if (next === null) return;
            const title = next.trim();
            if (!title || title === currentTitle) return;
            const art = currentArticle();
            const aliases = (art.aliases || []).slice();
            if (aliases.indexOf(currentTitle) === -1) aliases.push(currentTitle);
            const slug = uniqueSlug(title, currentId);
            await runTransaction(async function (tx) {
                const snap = await tx.get(articleRef(currentId));
                if (!snap.exists) throw new Error("Article is gone.");
                if (!timestampsEqual((snap.data() || {}).updatedAt, currentUpdatedAt)) {
                    const err = new Error("conflict"); err.code = "kb-conflict"; throw err;
                }
                tx.set(articleRef(currentId), { title: title, slug: slug, aliases: aliases, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            });
            await refreshCurrentFromServer(); enterViewMode();
        }
        async function deleteArticle() {
            if (!currentId) return;
            const art = currentArticle();
            if (!window.confirm("Delete “" + (art && art.title || "this article") + "”? This cannot be undone (the original Codex backup in the vault is not affected).")) return;
            const id = currentId;
            const vs = await versionsCol(id).get();
            const batch = batchFactory();
            vs.forEach(function (doc) { batch.delete(doc.ref); });
            batch.delete(articleRef(id));
            await batch.commit();
            clearDraft(id);
            articles = articles.filter(function (a) { return a.id !== id; });
            const next = articles[0] || null;
            if (next) openArticle(next.id, { skipLeave: true });
            else { adoptArticle(null); enterViewMode(); showEmpty("No articles yet"); renderArticleList(); }
        }
        async function refreshCurrentFromServer() {
            const snap = await articleRef(currentId).get();
            if (!snap.exists) throw new Error("Article is gone.");
            const art = mapArticle(currentId, snap.data());
            const idx = articles.findIndex(function (a) { return a.id === currentId; });
            if (idx >= 0) articles[idx] = art; else articles.push(art);
            sortArticles(); adoptArticle(art); return art;
        }
        async function writeVersionSnapshot(id, snapshot) {
            const col = versionsCol(id);
            await col.add({ title: snapshot.title, markdown: snapshot.markdown, tags: snapshot.tags || [], savedAt: FieldValue.serverTimestamp() });
            const all = await col.orderBy("savedAt", "desc").get();
            if (all.size <= VERSION_CAP) return;
            const batch = batchFactory();
            all.docs.slice(VERSION_CAP).forEach(function (doc) { batch.delete(doc.ref); });
            await batch.commit();
        }
        async function saveNotes(options) {
            const force = options && options.force;
            if (saving || !currentId) return;
            const payloadMd = editor.value;
            const payloadTitle = titleInput.value.trim() || "Untitled";
            const payloadTags = normalizeTags(tagInput.value);
            const size = estimatedDocSize(payloadMd, payloadTitle, payloadTags);
            if (size > DOC_LIMIT) {
                showError({ message: "This article is over the 1 MB Firestore document limit. Shorten it before saving." }, "save");
                updateSizeMeter(); return;
            }
            saving = true;
            saveBtn.disabled = true; $("saveBtnSticky").disabled = true;
            saveBtn.textContent = "Saving…"; $("saveBtnSticky").textContent = "Saving…";
            hideError();
            if (!force) conflictBanner.classList.add("hidden");
            const previous = { title: currentTitle, markdown: currentMarkdown, tags: currentTags.slice() };
            try {
                const slug = uniqueSlug(payloadTitle, currentId);
                await runTransaction(async function (tx) {
                    const snap = await tx.get(articleRef(currentId));
                    if (!snap.exists) throw new Error("Article is gone.");
                    const serverUpdated = (snap.data() || {}).updatedAt || null;
                    if (!force && !timestampsEqual(serverUpdated, currentUpdatedAt)) {
                        const err = new Error("conflict"); err.code = "kb-conflict"; throw err;
                    }
                    const aliases = ((snap.data() || {}).aliases || []).slice();
                    const prevTitle = (snap.data() || {}).title;
                    if (prevTitle && prevTitle !== payloadTitle && aliases.indexOf(prevTitle) === -1) aliases.push(prevTitle);
                    tx.set(articleRef(currentId), {
                        title: payloadTitle, slug: slug, tags: payloadTags, aliases: aliases,
                        markdown: payloadMd, updatedAt: FieldValue.serverTimestamp()
                    }, { merge: true });
                });
                try { await writeVersionSnapshot(currentId, previous); } catch (verErr) { console.warn("Version snapshot failed", verErr); }
                await refreshCurrentFromServer();
                clearDraft(currentId); conflictBanner.classList.add("hidden"); enterViewMode();
            } catch (err) {
                if (err && (err.code === "kb-conflict" || err.message === "conflict")) {
                    conflictBanner.classList.remove("hidden");
                    conflictBanner.scrollIntoView({ block: "nearest" });
                } else showError(err, "save");
            } finally {
                saving = false; saveBtn.disabled = false; $("saveBtnSticky").disabled = false;
                saveBtn.textContent = "Save"; $("saveBtnSticky").textContent = "Save";
            }
        }
        async function reloadServerCopy() {
            hideError();
            try {
                const previous = { markdown: editor.value, title: titleInput.value, tags: normalizeTags(tagInput.value) };
                await refreshCurrentFromServer();
                conflictBanner.classList.add("hidden");
                if (previous.markdown !== currentMarkdown || previous.title !== currentTitle) writeDraft(currentId, previous);
                enterEditMode();
                const draft = readDraft(currentId);
                if (draft && previous.markdown !== currentMarkdown) showDraftBanner(draft, "Your previous edits were kept as a local draft");
            } catch (err) { showError(err, "load"); }
        }
        function downloadText(filename, text, type) {
            const blob = new Blob([text], { type: type || "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
        function todayStamp() {
            const now = new Date();
            return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
        }
        function articleFileText(art) {
            const tags = (art.tags || []).join(", ");
            return "---\ntitle: " + art.title + "\nslug: " + art.slug + (tags ? "\ntags: " + tags : "") + "\n---\n\n" + (art.markdown || "");
        }
        function downloadBackup() {
            const art = currentArticle();
            if (!art) return;
            const live = editing ? { title: titleInput.value.trim() || art.title, slug: art.slug, tags: normalizeTags(tagInput.value), markdown: editor.value } : art;
            downloadText((live.slug || "article") + "-" + todayStamp() + ".md", articleFileText(live));
        }
        function crc32(bytes) {
            let c = ~0 >>> 0;
            for (let i = 0; i < bytes.length; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : (c >>> 1); }
            return ~c >>> 0;
        }
        function u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
        function u32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
        function zipFiles(files) {
            const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
            files.forEach(function (file) {
                const nameBytes = enc.encode(file.name);
                const data = typeof file.data === "string" ? enc.encode(file.data) : file.data;
                const crc = crc32(data);
                const local = new Uint8Array(30 + nameBytes.length + data.length);
                local.set([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
                local.set(u32(crc), 14); local.set(u32(data.length), 18); local.set(u32(data.length), 22);
                local.set(u16(nameBytes.length), 26); local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
                parts.push(local);
                const hdr = new Uint8Array(46 + nameBytes.length);
                hdr.set([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
                hdr.set(u32(crc), 16); hdr.set(u32(data.length), 20); hdr.set(u32(data.length), 24);
                hdr.set(u16(nameBytes.length), 28); hdr.set(u32(offset), 42); hdr.set(nameBytes, 46);
                central.push(hdr); offset += local.length;
            });
            let centralSize = 0; central.forEach(function (c) { centralSize += c.length; });
            const end = new Uint8Array(22);
            end.set([0x50, 0x4b, 0x05, 0x06], 0); end.set(u16(files.length), 8); end.set(u16(files.length), 10);
            end.set(u32(centralSize), 12); end.set(u32(offset), 16);
            const out = new Uint8Array(offset + centralSize + 22); let p = 0;
            parts.forEach(function (part) { out.set(part, p); p += part.length; });
            central.forEach(function (part) { out.set(part, p); p += part.length; });
            out.set(end, p);
            return new Blob([out], { type: "application/zip" });
        }
        function downloadBackupAll() {
            if (!articles.length) return;
            const used = {};
            const files = articles.map(function (art) {
                let name = (art.slug || "article") + ".md";
                if (used[name]) name = (art.slug || "article") + "-" + art.id.slice(0, 6) + ".md";
                used[name] = true;
                return { name: name, data: articleFileText(art) };
            });
            const blob = zipFiles(files);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "knowledge-backup-" + todayStamp() + ".zip";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }

        function clearSearch() { clearHighlights(rendered); searchHits = []; searchIndex = -1; searchCount.textContent = ""; }
        function clearHighlights(root) {
            root.querySelectorAll("mark.kb-hit").forEach(function (mark) {
                const parent = mark.parentNode; if (!parent) return;
                parent.replaceChild(document.createTextNode(mark.textContent), mark); parent.normalize();
            });
        }
        function highlightSearch(root, query) {
            clearHighlights(root);
            const hits = []; const q = query.toLowerCase();
            if (!q) return hits;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(q)) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement && node.parentElement.closest("mark, script, style")) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
            nodes.forEach(function (node) {
                const text = node.nodeValue, lower = text.toLowerCase();
                const frag = document.createDocumentFragment();
                let i = 0, idx;
                while ((idx = lower.indexOf(q, i)) !== -1) {
                    if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
                    const mark = document.createElement("mark"); mark.className = "kb-hit";
                    mark.textContent = text.slice(idx, idx + query.length);
                    frag.appendChild(mark); hits.push(mark); i = idx + q.length;
                }
                if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
                node.parentNode.replaceChild(frag, node);
            });
            return hits;
        }
        function setCurrentHit(index) {
            if (!searchHits.length) { searchCount.textContent = "No matches"; return; }
            searchHits.forEach(function (el) { el.classList.remove("is-current"); });
            searchIndex = (index + searchHits.length) % searchHits.length;
            searchHits[searchIndex].classList.add("is-current");
            searchHits[searchIndex].scrollIntoView({ block: "center" });
            searchCount.textContent = (searchIndex + 1) + " of " + searchHits.length;
        }
        function runSearch() {
            const query = searchInput.value.trim();
            if (!query) { clearSearch(); return; }
            searchHits = highlightSearch(rendered, query);
            if (!searchHits.length) { searchIndex = -1; searchCount.textContent = "No matches"; return; }
            setCurrentHit(0);
        }
        function applyFormat(type) {
            const start = editor.selectionStart, end = editor.selectionEnd, value = editor.value, selected = value.slice(start, end);
            function replace(next, selStart, selEnd) {
                editor.value = next; editor.focus(); editor.setSelectionRange(selStart, selEnd);
                editor.dispatchEvent(new Event("input", { bubbles: true }));
            }
            function wrap(before, after, placeholder) {
                const inner = selected || placeholder;
                const next = value.slice(0, start) + before + inner + after + value.slice(end);
                replace(next, start + before.length, start + before.length + inner.length);
            }
            function prefixLines(prefixer) {
                const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                const chunk = value.slice(lineStart, end);
                const nextChunk = chunk.split("\n").map(prefixer).join("\n");
                replace(value.slice(0, lineStart) + nextChunk + value.slice(end), lineStart, lineStart + nextChunk.length);
            }
            if (type === "bold") wrap("**", "**", "bold");
            else if (type === "italic") wrap("*", "*", "italic");
            else if (type === "code") selected.indexOf("\n") !== -1 ? wrap("```\n", "\n```", "code") : wrap("`", "`", "code");
            else if (type === "link") {
                const url = window.prompt("Link URL:", "https://");
                if (url === null) return;
                wrap("[", "](" + url + ")", selected || "text");
            } else if (type === "quote") prefixLines(function (line) { return line.startsWith(">") ? line : "> " + line; });
            else if (type === "ul") prefixLines(function (line) { return /^\s*[-*]\s/.test(line) ? line : "- " + line; });
            else if (type === "ol") prefixLines(function (line, i) { return /^\s*\d+\.\s/.test(line) ? line : (i + 1) + ". " + line; });
            else if (type === "heading") {
                const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                let lineEnd = value.indexOf("\n", start); if (lineEnd === -1) lineEnd = value.length;
                const line = value.slice(lineStart, lineEnd);
                const m = line.match(/^(#{1,3})\s/);
                let nextLine;
                if (!m) nextLine = "## " + line.replace(/^#+\s*/, "");
                else if (m[1] === "#") nextLine = "## " + line.slice(m[0].length);
                else if (m[1] === "##") nextLine = "### " + line.slice(m[0].length);
                else nextLine = line.slice(m[0].length);
                replace(value.slice(0, lineStart) + nextLine + value.slice(lineEnd), lineStart, lineStart + nextLine.length);
            } else if (type === "wikilink") toggleWikiPicker();
        }
        function toggleWikiPicker() {
            if (!wikiPicker.classList.contains("hidden")) { wikiPicker.classList.add("hidden"); wikiPicker.hidden = true; return; }
            wikiPicker.innerHTML = "";
            if (!articles.length) {
                const p = document.createElement("p"); p.textContent = "No articles to link yet."; wikiPicker.appendChild(p);
            } else {
                articles.forEach(function (art) {
                    const b = document.createElement("button"); b.type = "button"; b.className = "btn kb-wiki-pick"; b.textContent = art.title;
                    b.addEventListener("click", function () { insertWikiLink(art.title); wikiPicker.classList.add("hidden"); wikiPicker.hidden = true; });
                    wikiPicker.appendChild(b);
                });
            }
            wikiPicker.classList.remove("hidden"); wikiPicker.hidden = false;
        }
        function insertWikiLink(title) {
            const start = editor.selectionStart, end = editor.selectionEnd;
            const selected = editor.value.slice(start, end);
            const token = selected && selected !== title ? "[[" + title + "|" + selected + "]]" : "[[" + title + "]]";
            editor.value = editor.value.slice(0, start) + token + editor.value.slice(end);
            const pos = start + token.length;
            editor.focus(); editor.setSelectionRange(pos, pos);
            editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        function lineDiff(a, b) {
            const A = String(a || "").split("\n"), B = String(b || "").split("\n");
            if (A.length * B.length > 400000) return [{ type: "meta", text: "Diff is too large to render; use Preview instead." }];
            const n = A.length, m = B.length, dp = Array(n + 1);
            for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
            for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            const out = []; let i = 0, j = 0;
            while (i < n && j < m) {
                if (A[i] === B[j]) { out.push({ type: "same", text: A[i] }); i++; j++; }
                else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
                else { out.push({ type: "add", text: B[j] }); j++; }
            }
            while (i < n) out.push({ type: "del", text: A[i++] });
            while (j < m) out.push({ type: "add", text: B[j++] });
            return out;
        }
        function renderDiff(fromText, toText, root) {
            const pre = document.createElement("pre"); pre.className = "kb-diff";
            lineDiff(fromText, toText).forEach(function (row) {
                const div = document.createElement("div");
                div.className = "kb-diff-" + row.type;
                div.textContent = (row.type === "add" ? "+" : row.type === "del" ? "-" : row.type === "meta" ? "" : " ") + row.text;
                pre.appendChild(div);
            });
            root.innerHTML = ""; root.appendChild(pre);
        }
        async function openHistory() {
            if (!currentId || !confirmLeave()) return;
            selectedVersion = null;
            historyPanel.classList.remove("hidden"); historyPanel.hidden = false;
            historyBackdrop.classList.remove("hidden"); historyBackdrop.hidden = false;
            historyContent.innerHTML = ""; historyActions.classList.add("hidden");
            historyList.innerHTML = "Loading…";
            try {
                const snap = await versionsCol(currentId).orderBy("savedAt", "desc").get();
                historyList.innerHTML = "";
                if (snap.empty) { historyEmpty.classList.remove("hidden"); return; }
                historyEmpty.classList.add("hidden");
                snap.forEach(function (doc) {
                    const data = doc.data() || {};
                    const btn = document.createElement("button"); btn.type = "button"; btn.className = "kb-history-item";
                    const t = document.createElement("span"); t.textContent = formatVersion(data.savedAt);
                    const n = document.createElement("span"); n.className = "kb-history-item-title"; n.textContent = data.title || currentTitle;
                    btn.appendChild(t); btn.appendChild(n);
                    btn.addEventListener("click", function () {
                        selectedVersion = { id: doc.id, title: data.title || currentTitle, markdown: data.markdown || "", tags: normalizeTags(data.tags || []), savedAt: data.savedAt };
                        Array.from(historyList.children).forEach(function (el) { el.classList.toggle("is-active", el === btn); });
                        historyActions.classList.remove("hidden"); showHistoryPreview();
                    });
                    historyList.appendChild(btn);
                });
            } catch (err) { historyList.innerHTML = ""; showError(err, "load"); }
        }
        function closeHistory() {
            historyPanel.classList.add("hidden"); historyPanel.hidden = true;
            historyBackdrop.classList.add("hidden"); historyBackdrop.hidden = true;
            selectedVersion = null;
        }
        function showHistoryPreview() { if (selectedVersion) renderMarkdown(selectedVersion.markdown, historyContent); }
        function showHistoryDiff() { if (selectedVersion) renderDiff(selectedVersion.markdown, currentMarkdown, historyContent); }
        async function restoreVersion() {
            if (!selectedVersion || !currentId) return;
            if (!window.confirm("Restore this version from " + formatVersion(selectedVersion.savedAt) + "? The current text will stay in History after you save.")) return;
            const version = selectedVersion;
            closeHistory();
            enterEditMode({ markdown: version.markdown, title: version.title, tags: version.tags });
            await saveNotes({ force: true });
        }
        function bindWikiClicks(root) {
            root.addEventListener("click", function (event) {
                const create = event.target.closest("a[data-create]");
                if (create) {
                    event.preventDefault();
                    const title = create.getAttribute("data-create") || "";
                    if (title && window.confirm("Create a new article named “" + title + "”?")) promptNewArticle(title, "", true);
                    return;
                }
                const link = event.target.closest("a[data-article]");
                if (link) { event.preventDefault(); openArticle(link.getAttribute("data-article")); }
            });
        }
        bindWikiClicks(rendered); bindWikiClicks(editPreview);

        function onKeyboardInset() {
            const vv = window.visualViewport;
            if (!vv) { document.documentElement.style.setProperty("--kb-keyboard-inset", "0px"); return; }
            const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            document.documentElement.style.setProperty("--kb-keyboard-inset", inset + "px");
        }
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", onKeyboardInset);
            window.visualViewport.addEventListener("scroll", onKeyboardInset);
        }
        window.addEventListener("resize", onKeyboardInset);
        onKeyboardInset();

        const newBtn = $("newArticleBtn");
        const editBtn = $("editBtn");
        const cancelBtn = $("cancelBtn");
        const formatBar = $("formatBar");
        const searchPrev = $("searchPrev");
        const searchNext = $("searchNext");
        tocToggle.addEventListener("click", function () {
            const open = toc.classList.toggle("is-open");
            tocToggle.setAttribute("aria-expanded", open ? "true" : "false");
        });
        if (railToggle) {
            railToggle.addEventListener("click", function () {
                const open = document.body.classList.toggle("kb-rail-open");
                railToggle.setAttribute("aria-expanded", open ? "true" : "false");
            });
        }


        $("newArticleBtn").addEventListener("click", function () { promptNewArticle(); });
        $("emptyEditBtn").addEventListener("click", function () {
            if (!currentId) promptNewArticle();
            else { const draft = readDraft(currentId); enterEditMode(draft || undefined); }
        });
        articleSearch.addEventListener("input", function () { articleFilter = articleSearch.value; renderArticleList(); });
        editBtn.addEventListener("click", function () { const draft = readDraft(currentId); enterEditMode(draft || undefined); });
        cancelBtn.addEventListener("click", function () { if (confirmLeave()) enterViewMode(); });
        $("cancelBtnSticky").addEventListener("click", function () { if (confirmLeave()) enterViewMode(); });
        saveBtn.addEventListener("click", function () { saveNotes(); });
        $("saveBtnSticky").addEventListener("click", function () { saveNotes(); });
        $("backupAllBtn").addEventListener("click", downloadBackupAll);
        $("backupBtn").addEventListener("click", downloadBackup);
        $("backupBtnEdit").addEventListener("click", downloadBackup);
        $("historyBtn").addEventListener("click", openHistory);
        $("renameBtn").addEventListener("click", renameArticle);
        $("deleteBtn").addEventListener("click", deleteArticle);
        $("historyCloseBtn").addEventListener("click", closeHistory);
        historyBackdrop.addEventListener("click", closeHistory);
        $("historyPreviewBtn").addEventListener("click", showHistoryPreview);
        $("historyDiffBtn").addEventListener("click", showHistoryDiff);
        $("historyRestoreBtn").addEventListener("click", restoreVersion);
        $("conflictReloadBtn").addEventListener("click", reloadServerCopy);
        $("conflictOverwriteBtn").addEventListener("click", function () { saveNotes({ force: true }); });
        $("draftRestoreBtn").addEventListener("click", function () { const d = readDraft(currentId); if (d) enterEditMode(d); draftBanner.classList.add("hidden"); });
        $("draftDiscardBtn").addEventListener("click", function () { clearDraft(currentId); if (editing) enterEditMode(); });
        previewToggle.addEventListener("click", function () { setPreviewMode(!editSplit.classList.contains("is-preview")); });
        previewToggleSticky.addEventListener("click", function () { setPreviewMode(!editSplit.classList.contains("is-preview")); });
        formatBar.addEventListener("click", function (event) {
            const btn = event.target.closest("[data-fmt]");
            if (btn) applyFormat(btn.getAttribute("data-fmt"));
        });
        editor.addEventListener("input", function () { schedulePreview(); scheduleAutosave(); updateSizeMeter(); });
        titleInput.addEventListener("input", function () { scheduleAutosave(); updateSizeMeter(); });
        tagInput.addEventListener("input", function () { scheduleAutosave(); updateSizeMeter(); });
        editor.addEventListener("keydown", function (event) {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveNotes(); }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); applyFormat("bold"); }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") { event.preventDefault(); applyFormat("italic"); }
            if (event.key === "Tab") {
                event.preventDefault();
                const start = editor.selectionStart, end = editor.selectionEnd;
                editor.value = editor.value.slice(0, start) + "  " + editor.value.slice(end);
                editor.setSelectionRange(start + 2, start + 2);
                editor.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });
        searchInput.addEventListener("input", runSearch);
        searchPrev.addEventListener("click", function () { if (searchHits.length) setCurrentHit(searchIndex - 1); });
        searchNext.addEventListener("click", function () { if (searchHits.length) setCurrentHit(searchIndex + 1); });
        searchInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") { event.preventDefault(); if (searchHits.length) setCurrentHit(searchIndex + (event.shiftKey ? -1 : 1)); }
        });
        window.addEventListener("beforeunload", function (event) { if (isDirty()) event.preventDefault(); });
        document.addEventListener("click", function (event) {
            const a = event.target.closest("a[href]");
            if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
            if ((a.getAttribute("href") || "").indexOf("blob:") === 0) return;
            if (!isDirty()) return;
            if (!window.confirm("You have unsaved changes. Leave without saving?")) event.preventDefault();
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !historyPanel.classList.contains("hidden")) closeHistory();
        });

        function installMock(seed) {
            const store = { "private/knowledge": seed && seed.legacy ? { markdown: seed.legacy.markdown || "", updatedAt: seed.legacy.updatedAt || stampNow() } : null };
            const articlesStore = (seed && seed.articles) ? JSON.parse(JSON.stringify(seed.articles)) : {};
            const versionsStore = (seed && seed.versions) ? JSON.parse(JSON.stringify(seed.versions)) : {};
            const meta = (seed && seed.meta) ? JSON.parse(JSON.stringify(seed.meta)) : {};
            let persistCalls = 0, legacyWrites = 0, auto = 1, clock = Date.now();
            function pathOf(ref) { return ref && ref.path ? ref.path : ""; }
            function stamp() { clock += 250; return { seconds: Math.floor(clock / 1000), nanoseconds: (clock % 1000) * 1e6 }; }
            function fillTs(data) {
                const out = JSON.parse(JSON.stringify(data || {}));
                Object.keys(out).forEach(function (k) {
                    if (out[k] && out[k].__server === true) out[k] = stamp();
                    if (out[k] && typeof out[k] === "object" && !("seconds" in out[k]) && !Array.isArray(out[k])) out[k] = fillTs(out[k]);
                });
                return out;
            }
            function snapFor(path, data, exists) {
                return {
                    exists: !!exists, id: path.split("/").pop(),
                    data: function () { return data ? JSON.parse(JSON.stringify(data)) : undefined; },
                    ref: { path: path, id: path.split("/").pop() }
                };
            }
            function getPath(path) {
                if (path === "private/knowledge") return store[path] ? snapFor(path, store[path], true) : snapFor(path, null, false);
                if (path === "private/kb") return Object.keys(meta).length ? snapFor(path, meta, true) : snapFor(path, null, false);
                const art = path.match(/^private\/kb\/articles\/([^/]+)$/);
                if (art) return articlesStore[art[1]] ? snapFor(path, articlesStore[art[1]], true) : snapFor(path, null, false);
                return snapFor(path, null, false);
            }
            function setPath(path, data, merge) {
                if (path === "private/knowledge") { legacyWrites++; throw new Error("mock forbids writing private/knowledge"); }
                const filled = fillTs(data);
                if (path === "private/kb") { if (merge) Object.assign(meta, filled); else { Object.keys(meta).forEach(function (k) { delete meta[k]; }); Object.assign(meta, filled); } return; }
                const art = path.match(/^private\/kb\/articles\/([^/]+)$/);
                if (art) {
                    if (merge && articlesStore[art[1]]) Object.assign(articlesStore[art[1]], filled);
                    else articlesStore[art[1]] = filled;
                    return;
                }
                const ver = path.match(/^private\/kb\/articles\/([^/]+)\/versions\/([^/]+)$/);
                if (ver) {
                    versionsStore[ver[1]] = versionsStore[ver[1]] || {};
                    versionsStore[ver[1]][ver[2]] = filled;
                }
            }
            function deletePath(path) {
                if (path === "private/knowledge") { legacyWrites++; throw new Error("mock forbids writing private/knowledge"); }
                const art = path.match(/^private\/kb\/articles\/([^/]+)$/);
                if (art) { delete articlesStore[art[1]]; return; }
                const ver = path.match(/^private\/kb\/articles\/([^/]+)\/versions\/([^/]+)$/);
                if (ver && versionsStore[ver[1]]) delete versionsStore[ver[1]][ver[2]];
            }
            function makeRef(path) {
                const ref = {
                    path: path, id: path.split("/").pop(),
                    get: async function () { return getPath(path); },
                    set: async function (data, opts) { setPath(path, data, opts && opts.merge); },
                    delete: async function () { deletePath(path); },
                    collection: function (name) { return makeCol(path + "/" + name); }
                };
                return ref;
            }
            function makeCol(path) {
                const col = {
                    path: path,
                    doc: function (id) { return makeRef(path + "/" + (id || ("auto" + auto++))); },
                    add: async function (data) {
                        const id = "auto" + auto++;
                        setPath(path + "/" + id, data, false);
                        return makeRef(path + "/" + id);
                    },
                    get: async function () { return querySnap(path); },
                    limit: function () { return { get: async function () { return querySnap(path); } }; },
                    orderBy: function (field, dir) { return { get: async function () { return querySnap(path, field, dir); } }; }
                };
                return col;
            }
            function querySnap(path, field, dir) {
                let rows = [];
                if (path === "private/kb/articles") {
                    rows = Object.keys(articlesStore).map(function (id) { return snapFor(path + "/" + id, articlesStore[id], true); });
                } else {
                    const ver = path.match(/^private\/kb\/articles\/([^/]+)\/versions$/);
                    if (ver) {
                        const bag = versionsStore[ver[1]] || {};
                        rows = Object.keys(bag).map(function (id) { return snapFor(path + "/" + id, bag[id], true); });
                    }
                }
                if (field) {
                    rows.sort(function (a, b) {
                        const av = tsMillis(a.data()[field]), bv = tsMillis(b.data()[field]);
                        return (dir === "asc" ? av - bv : bv - av);
                    });
                }
                return {
                    empty: !rows.length, size: rows.length, docs: rows,
                    forEach: function (fn) { rows.forEach(fn); }
                };
            }
            function mockTx() {
                return {
                    get: async function (ref) { return getPath(pathOf(ref)); },
                    set: function (ref, data, opts) { setPath(pathOf(ref), data, opts && opts.merge); },
                    delete: function (ref) { deletePath(pathOf(ref)); }
                };
            }
            const mockDb = {
                collection: function (name) { return makeCol(name); },
                enablePersistence: async function () { persistCalls++; persistStatus = "enabled"; }
            };
            db = mockDb;
            FieldValue = { serverTimestamp: function () { return { __server: true }; } };
            runTransaction = async function (fn) { return fn(mockTx()); };
            batchFactory = function () {
                const ops = [];
                return {
                    delete: function (ref) { ops.push(function () { deletePath(pathOf(ref)); }); },
                    set: function (ref, data, opts) { ops.push(function () { setPath(pathOf(ref), data, opts && opts.merge); }); },
                    commit: async function () { ops.forEach(function (op) { op(); }); }
                };
            };
            firebase = firebase || {};
            firebase.firestore = firebase.firestore || function () { return mockDb; };
            firebase.firestore.FieldValue = FieldValue;
            articlesCol = db.collection("private").doc("kb").collection("articles");
            kbMetaRef = db.collection("private").doc("kb");
            legacyRef = db.collection("private").doc("knowledge");
            return {
                getLegacy: function () { return store["private/knowledge"]; },
                getArticles: function () { return JSON.parse(JSON.stringify(articlesStore)); },
                getVersions: function (id) { return JSON.parse(JSON.stringify(versionsStore[id] || {})); },
                getMeta: function () { return JSON.parse(JSON.stringify(meta)); },
                persistCalls: function () { return persistCalls; },
                legacyWrites: function () { return legacyWrites; }
            };
        }

        window.NaedmasKnowledge = {
            start: start,
            installMock: installMock,
            persistStatus: function () { return persistStatus; },
            getState: function () {
                return {
                    currentId: currentId, currentTitle: currentTitle, currentMarkdown: currentMarkdown,
                    currentTags: currentTags.slice(), editing: editing, articleCount: articles.length,
                    articles: articles.map(function (a) { return { id: a.id, title: a.title, slug: a.slug, tags: a.tags.slice(), aliases: (a.aliases || []).slice(), markdown: a.markdown }; })
                };
            },
            openArticle: openArticle,
            createArticle: createArticle,
            promptNewArticle: promptNewArticle,
            renameArticle: renameArticle,
            deleteArticle: deleteArticle,
            enterEditMode: enterEditMode,
            enterViewMode: enterViewMode,
            saveNotes: saveNotes,
            applyFormat: applyFormat,
            insertWikiLink: insertWikiLink,
            openHistory: openHistory,
            closeHistory: closeHistory,
            restoreVersion: restoreVersion,
            downloadBackup: downloadBackup,
            downloadBackupAll: downloadBackupAll,
            setEditor: function (md) { editor.value = md; editor.dispatchEvent(new Event("input", { bubbles: true })); },
            setTitle: function (t) { titleInput.value = t; titleInput.dispatchEvent(new Event("input", { bubbles: true })); },
            setTags: function (t) { tagInput.value = t; tagInput.dispatchEvent(new Event("input", { bubbles: true })); }
        };

        function boot() {
            if (window.location.search.indexOf("kbmock=1") !== -1) return;
            if (typeof initAuth !== "function") { showError({ message: "Auth helper failed to load." }, "load"); return; }
            initAuth({
                onAuthorized: function () { start(); },
                onDenied: function () {},
                onSignedOut: function () {}
            });
        }
        boot();
    });
})();
