(function () {
    const PLACEHOLDER = "/librarium/img/placeholder.svg";
    const DATA_URL = "/librarium/books.json";

    const grid = document.getElementById("bookGrid");
    const empty = document.getElementById("galleryEmpty");
    const countEl = document.getElementById("galleryCount");
    const searchInput = document.getElementById("bookSearch");
    const lightbox = document.getElementById("lightbox");
    const lightboxArt = document.getElementById("lightboxArt");
    const lightboxTitle = document.getElementById("lightboxTitle");
    const lightboxKicker = document.getElementById("lightboxKicker");
    const lightboxFields = document.getElementById("lightboxFields");
    const lightboxClose = document.getElementById("lightboxClose");
    const lightboxCredit = document.getElementById("lightboxCredit");

    const state = {
        books: [],
        query: "",
        type: "",
        focus: "",
        series: "",
        status: "",
        author: "",
        openId: null
    };

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function uniqueSorted(values) {
        return Array.from(new Set(values.filter(Boolean))).sort(function (a, b) {
            return a.localeCompare(b, "en", { sensitivity: "base" });
        });
    }

    function statusClass(status) {
        const key = String(status || "").toLowerCase();
        if (key === "read") return "is-read";
        if (key === "reading") return "is-reading";
        if (key === "on hold") return "is-on-hold";
        if (key === "abandoned") return "is-abandoned";
        if (key === "not started") return "is-not-started";
        return "";
    }

    function asset(rel) {
        return rel ? "/librarium/" + rel : "";
    }

    function artTag(book, kind) {
        const jpgRel = kind === "full" ? (book.image || book.thumb) : (book.thumb || book.image);
        const webpRel = kind === "full" ? (book.imageWebp || book.thumbWebp) : (book.thumbWebp || book.imageWebp);
        if (!jpgRel && !webpRel) {
            return '<img class="book-placeholder" src="' + PLACEHOLDER + '" alt="">';
        }
        const alt = escapeHtml(book.title || "");
        let html = '<picture>';
        if (webpRel) html += '<source type="image/webp" srcset="' + escapeHtml(asset(webpRel)) + '">';
        html += '<img src="' + escapeHtml(asset(jpgRel || webpRel)) + '" alt="' + alt + '">';
        html += "</picture>";
        return html;
    }

    function haystack(book) {
        return [
            book.title, book.author, book.series, book.type, book.status,
            book.edition, book.summary,
            (book.focus || []).join(" "),
            (book.characters || []).join(" ")
        ].join(" ").toLowerCase();
    }

    function filtered() {
        const q = state.query.trim().toLowerCase();
        return state.books.filter(function (book) {
            if (state.type && book.type !== state.type) return false;
            if (state.series && book.series !== state.series) return false;
            if (state.status && book.status !== state.status) return false;
            if (state.author && book.author !== state.author) return false;
            if (state.focus && (book.focus || []).indexOf(state.focus) === -1) return false;
            if (q && haystack(book).indexOf(q) === -1) return false;
            return true;
        });
    }

    function renderChips(containerId, key, values, label) {
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!values.length) {
            el.innerHTML = "";
            el.hidden = true;
            return;
        }
        el.hidden = false;
        const buttons = ['<span class="chip-label">' + escapeHtml(label) + "</span>"];
        buttons.push(
            '<button type="button" class="chip' + (state[key] === "" ? " is-active" : "") +
            '" data-filter="' + key + '" data-value="">All</button>'
        );
        values.forEach(function (value) {
            const active = state[key] === value ? " is-active" : "";
            buttons.push(
                '<button type="button" class="chip' + active +
                '" data-filter="' + key + '" data-value="' + escapeHtml(value) + '">' +
                escapeHtml(value) + "</button>"
            );
        });
        el.innerHTML = buttons.join("");
    }

    function renderFilters() {
        renderChips("typeChips", "type", uniqueSorted(state.books.map(function (b) { return b.type; })), "Type");
        const focuses = [];
        state.books.forEach(function (b) { (b.focus || []).forEach(function (f) { focuses.push(f); }); });
        renderChips("focusChips", "focus", uniqueSorted(focuses), "Focus");
        renderChips("seriesChips", "series", uniqueSorted(state.books.map(function (b) { return b.series; })), "Series");
        renderChips("statusChips", "status", uniqueSorted(state.books.map(function (b) { return b.status; })), "Read");
        renderChips("authorChips", "author", uniqueSorted(state.books.map(function (b) { return b.author; })), "Author");
    }

    function renderGrid() {
        const books = filtered();
        countEl.textContent = "Showing " + books.length + " of " + state.books.length;
        if (!books.length) {
            grid.innerHTML = "";
            empty.classList.remove("hidden");
            return;
        }
        empty.classList.add("hidden");
        grid.innerHTML = books.map(function (book) {
            return (
                '<button type="button" class="book-card" data-id="' + escapeHtml(book.id) + '">' +
                    '<div class="book-card-art">' +
                        artTag(book, "thumb") +
                    "</div>" +
                    '<div class="book-card-body">' +
                        "<h2>" + escapeHtml(book.title) + "</h2>" +
                        '<p class="book-author">' + escapeHtml(book.author || "") + "</p>" +
                        (book.series ? '<p class="book-series">' + escapeHtml(book.series) + "</p>" : "") +
                        '<div class="book-card-tags">' +
                            (book.type ? '<span class="book-type">' + escapeHtml(book.type) + "</span>" : "") +
                            (book.status
                                ? '<span class="status-badge ' + statusClass(book.status) + '">' +
                                  escapeHtml(book.status) + "</span>"
                                : "") +
                        "</div>" +
                    "</div>" +
                "</button>"
            );
        }).join("");
    }

    function fieldRow(label, valueHtml) {
        if (!valueHtml) return "";
        return (
            "<div>" +
                '<dt class="detail-kicker">' + escapeHtml(label) + "</dt>" +
                '<dd class="detail-value">' + valueHtml + "</dd>" +
            "</div>"
        );
    }

    function openLightbox(id) {
        const book = state.books.find(function (b) { return b.id === id; });
        if (!book) return;
        state.openId = id;
        lightboxArt.innerHTML = artTag(book, "full");
        if (lightboxCredit) {
            const hasCover = !!(book.image || book.imageWebp);
            lightboxCredit.classList.toggle("hidden", !hasCover);
        }
        lightboxKicker.textContent = book.type || "The Shelf";
        lightboxTitle.textContent = book.title;
        const focusHtml = (book.focus || []).map(function (f) {
            return '<span class="book-type">' + escapeHtml(f) + "</span>";
        }).join(" ");
        const charHtml = (book.characters || []).length
            ? '<ul class="book-character-list">' + book.characters.map(function (name) {
                return "<li>" + escapeHtml(name) + "</li>";
            }).join("") + "</ul>"
            : "";
        const linkHtml = book.officialLink
            ? '<a href="' + escapeHtml(book.officialLink) + '" target="_blank" rel="noopener noreferrer">Lore page</a>'
            : "";
        lightboxFields.innerHTML = [
            fieldRow("Author", book.author ? escapeHtml(book.author) : ""),
            fieldRow("Series", book.series ? escapeHtml(book.series) : ""),
            fieldRow("Type", book.type ? escapeHtml(book.type) : ""),
            fieldRow("Focus", focusHtml),
            fieldRow("Read", book.status
                ? '<span class="status-badge ' + statusClass(book.status) + '">' + escapeHtml(book.status) + "</span>"
                : ""),
            fieldRow("Edition", book.edition && book.edition !== "Any" ? escapeHtml(book.edition) : ""),
            fieldRow("Summary", book.summary ? escapeHtml(book.summary) : ""),
            fieldRow("Characters", charHtml),
            fieldRow("Further reading", linkHtml)
        ].join("");
        lightbox.classList.remove("hidden");
        lightbox.hidden = false;
        document.body.classList.add("lightbox-open");
        if (location.hash !== "#" + id) {
            history.replaceState(null, "", "#" + id);
        }
    }

    function closeLightbox() {
        state.openId = null;
        lightbox.classList.add("hidden");
        lightbox.hidden = true;
        document.body.classList.remove("lightbox-open");
        if (location.hash) {
            history.replaceState(null, "", location.pathname + location.search);
        }
    }

    function applyHash() {
        const id = (location.hash || "").replace(/^#/, "");
        if (id) openLightbox(id);
        else if (state.openId) closeLightbox();
    }

    function render() {
        renderFilters();
        renderGrid();
    }

    document.addEventListener("click", function (event) {
        const chip = event.target.closest("[data-filter]");
        if (chip) {
            const key = chip.getAttribute("data-filter");
            const value = chip.getAttribute("data-value") || "";
            state[key] = state[key] === value ? "" : value;
            render();
            return;
        }
        const card = event.target.closest(".book-card");
        if (card) openLightbox(card.getAttribute("data-id"));
    });

    searchInput.addEventListener("input", function () {
        state.query = searchInput.value;
        renderGrid();
    });

    lightboxClose.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", function (event) {
        if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && state.openId) closeLightbox();
    });
    window.addEventListener("hashchange", applyHash);

    fetch(DATA_URL, { cache: "no-cache" })
        .then(function (res) {
            if (!res.ok) throw new Error("Could not load the librarium.");
            return res.json();
        })
        .then(function (data) {
            state.books = data.books || [];
            render();
            applyHash();
        })
        .catch(function (err) {
            console.error(err);
            countEl.textContent = "";
            empty.textContent = "The librarium could not be opened.";
            empty.classList.remove("hidden");
        });
})();
