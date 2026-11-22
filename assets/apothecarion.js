(function () {
    const PLACEHOLDER = "/apothecarion/img/placeholder.svg";
    const DATA_URL = "/apothecarion/bits.json";

    const grid = document.getElementById("bitGrid");
    const empty = document.getElementById("galleryEmpty");
    const countEl = document.getElementById("galleryCount");
    const searchInput = document.getElementById("bitSearch");
    const lightbox = document.getElementById("lightbox");
    const lightboxArt = document.getElementById("lightboxArt");
    const lightboxTitle = document.getElementById("lightboxTitle");
    const lightboxKicker = document.getElementById("lightboxKicker");
    const lightboxFields = document.getElementById("lightboxFields");
    const lightboxClose = document.getElementById("lightboxClose");

    const state = {
        bits: [],
        query: "",
        armourType: "",
        faction: "",
        kit: "",
        sort: "name",
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

    function asset(rel) {
        return rel ? "/apothecarion/" + rel : "";
    }

    function artTag(bit, kind) {
        const jpgRel = kind === "full" ? (bit.image || bit.thumb) : (bit.thumb || bit.image);
        const webpRel = kind === "full" ? (bit.imageWebp || bit.thumbWebp) : (bit.thumbWebp || bit.imageWebp);
        if (!jpgRel && !webpRel) {
            return '<img class="bit-placeholder" src="' + PLACEHOLDER + '" alt="">';
        }
        const alt = escapeHtml(bit.name || "");
        const loading = kind === "full" ? "eager" : "lazy";
        let html = "<picture>";
        if (webpRel) html += '<source type="image/webp" srcset="' + escapeHtml(asset(webpRel)) + '">';
        html += '<img src="' + escapeHtml(asset(jpgRel || webpRel)) + '" alt="' + alt + '" loading="' + loading + '" decoding="async">';
        html += "</picture>";
        return html;
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function searchFields(bit) {
        return [bit.name, bit.armourType, bit.faction]
            .concat(bit.kits || [], bit.models || [], bit.keywords || [])
            .filter(Boolean)
            .map(function (value) { return String(value); });
    }

    function matchesQuery(bit, query) {
        const q = String(query || "").trim().replace(/\s+/g, " ");
        if (!q) return true;
        const pattern = new RegExp("\\b" + escapeRegExp(q) + "\\b", "i");
        return searchFields(bit).some(function (field) {
            return pattern.test(field);
        });
    }

    function byName(a, b) {
        return (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" });
    }

    function filtered() {
        const q = state.query.trim().toLowerCase();
        const bits = state.bits.filter(function (bit) {
            if (state.armourType && (bit.armourType || "Unspecified") !== state.armourType) return false;
            if (state.faction && bit.faction !== state.faction) return false;
            if (state.kit && (bit.kits || []).indexOf(state.kit) === -1) return false;
            if (q && !matchesQuery(bit, q)) return false;
            return true;
        });
        if (state.sort !== "qty-desc") return bits;
        return bits.slice().sort(function (a, b) {
            const aHas = typeof a.qty === "number";
            const bHas = typeof b.qty === "number";
            if (aHas && bHas && b.qty !== a.qty) return b.qty - a.qty;
            if (aHas && !bHas) return -1;
            if (!aHas && bHas) return 1;
            return byName(a, b);
        });
    }

    function renderChips(containerId, label, key, values) {
        const row = document.getElementById(containerId);
        if (!row) return;
        const current = state[key] || "";
        let html = '<span class="chip-label">' + escapeHtml(label) + "</span>";
        html += '<button type="button" class="chip' + (current ? "" : " is-active") + '" data-filter="' + key + '" data-value="">All</button>';
        values.forEach(function (value) {
            html += '<button type="button" class="chip' + (current === value ? " is-active" : "") +
                '" data-filter="' + key + '" data-value="' + escapeHtml(value) + '">' +
                escapeHtml(value) + "</button>";
        });
        row.innerHTML = html;
    }

    function renderFilters() {
        const armour = uniqueSorted(state.bits.map(function (b) { return b.armourType || "Unspecified"; }));
        const factions = uniqueSorted(state.bits.map(function (b) { return b.faction; }));
        const kits = uniqueSorted(state.bits.flatMap(function (b) { return b.kits || []; }));
        renderChips("armourChips", "Armour", "armourType", armour);
        renderChips("factionChips", "Faction", "faction", factions);
        renderChips("kitChips", "Kit", "kit", kits);
        renderSort();
    }

    function renderSort() {
        const row = document.getElementById("sortChips");
        if (!row) return;
        const current = state.sort || "name";
        const options = [
            { value: "name", label: "Name" },
            { value: "qty-desc", label: "Quantity" }
        ];
        let html = '<span class="chip-label">Sort</span>';
        options.forEach(function (option) {
            html += '<button type="button" class="chip' + (current === option.value ? " is-active" : "") +
                '" data-sort="' + option.value + '">' + escapeHtml(option.label) + "</button>";
        });
        row.innerHTML = html;
    }

    function renderGrid() {
        const bits = filtered();
        countEl.textContent = "Showing " + bits.length + " of " + state.bits.length;
        empty.classList.toggle("hidden", bits.length > 0);
        grid.innerHTML = bits.map(function (bit) {
            const subtitle = (bit.kits && bit.kits[0]) || (bit.models && bit.models[0]) || "";
            const armour = bit.armourType ? '<span class="bit-armour">' + escapeHtml(bit.armourType) + "</span>" : "";
            const qtyBadge = typeof bit.qty === "number"
                ? '<span class="bit-qty" aria-label="Quantity ' + bit.qty + '">x' + bit.qty + "</span>"
                : "";
            const keywords = (bit.keywords || []).slice(0, 4).map(function (word) {
                return keywordChip(word, true);
            }).join("");
            return '<article class="bit-card" data-id="' + escapeHtml(bit.id) + '" tabindex="0" role="button" aria-label="' + escapeHtml(bit.name) + '">' +
                '<span class="bit-card-art">' + artTag(bit, "thumb") + qtyBadge + "</span>" +
                '<span class="bit-card-body">' +
                "<h2>" + escapeHtml(bit.name) + "</h2>" +
                (subtitle ? '<span class="bit-kit">' + escapeHtml(subtitle) + "</span>" : "") +
                '<span class="bit-card-tags">' + armour + keywords + "</span>" +
                "</span></article>";
        }).join("");
    }

    function fieldRow(label, value) {
        if (!value) return "";
        return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + value + "</dd></div>";
    }

    function openLightbox(id) {
        const bit = state.bits.find(function (item) { return item.id === id; });
        if (!bit) return;
        state.openId = id;
        lightboxArt.innerHTML = artTag(bit, "full");
        lightboxTitle.textContent = bit.name;
        lightboxKicker.textContent = bit.armourType || "The Helix";
        const kitHtml = (bit.kits || []).length
            ? "<ul class=\"bit-list\">" + bit.kits.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul>"
            : "";
        const modelHtml = (bit.models || []).length
            ? "<ul class=\"bit-list\">" + bit.models.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul>"
            : "";
        const keywordHtml = (bit.keywords || []).length
            ? '<div class="bit-keyword-list">' + bit.keywords.map(function (word) {
                return keywordChip(word, false);
            }).join("") + "</div>"
            : "";
        lightboxFields.innerHTML =
            fieldRow("Armour type", bit.armourType ? escapeHtml(bit.armourType) : "") +
            fieldRow("Quantity", typeof bit.qty === "number" ? String(bit.qty) : "") +
            fieldRow("Keywords", keywordHtml) +
            fieldRow("Kit", kitHtml) +
            fieldRow("Model", modelHtml) +
            fieldRow("Faction", bit.faction ? escapeHtml(bit.faction) : "");
        lightbox.classList.remove("hidden");
        lightbox.hidden = false;
        lightboxClose.focus();
        const url = new URL(location.href);
        url.hash = "bit=" + encodeURIComponent(id);
        history.replaceState(null, "", url.pathname + url.search + url.hash);
    }

    function closeLightbox() {
        state.openId = null;
        lightbox.classList.add("hidden");
        lightbox.hidden = true;
        const url = new URL(location.href);
        history.replaceState(null, "", url.pathname + url.search);
    }

    function keywordChip(label, subtle) {
        return '<button type="button" class="bit-keyword' + (subtle ? " is-subtle" : "") +
            '" data-keyword="' + escapeHtml(label) + '">' + escapeHtml(label) + "</button>";
    }

    function searchByKeyword(term) {
        if (!term) return;
        searchInput.value = term;
        state.query = term;
        if (state.openId) closeLightbox();
        renderGrid();
        try { searchInput.focus(); } catch (err) {}
        const tools = document.querySelector(".gallery-tools");
        if (tools && typeof tools.scrollIntoView === "function") {
            tools.scrollIntoView({ block: "start" });
        }
    }

    function onKeywordClick(event) {
        const btn = event.target.closest("[data-keyword]");
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        searchByKeyword(btn.getAttribute("data-keyword") || "");
    }

    function onGridClick(event) {
        const keywordBtn = event.target.closest("[data-keyword]");
        if (keywordBtn) {
            event.preventDefault();
            event.stopPropagation();
            searchByKeyword(keywordBtn.getAttribute("data-keyword") || "");
            return;
        }
        const card = event.target.closest(".bit-card");
        if (!card) return;
        openLightbox(card.getAttribute("data-id"));
    }

    function onGridKeydown(event) {
        if (event.target.closest("[data-keyword]")) return;
        const card = event.target.closest(".bit-card");
        if (!card || !grid.contains(card)) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openLightbox(card.getAttribute("data-id"));
        }
    }

    function onChipClick(event) {
        const btn = event.target.closest(".chip");
        if (!btn) return;
        const sort = btn.getAttribute("data-sort");
        if (sort) {
            state.sort = sort;
            renderSort();
            renderGrid();
            return;
        }
        const key = btn.getAttribute("data-filter");
        const value = btn.getAttribute("data-value") || "";
        state[key] = state[key] === value ? "" : value;
        renderFilters();
        renderGrid();
    }

    document.querySelector(".gallery-tools").addEventListener("click", onChipClick);
    grid.addEventListener("click", onGridClick);
    grid.addEventListener("keydown", onGridKeydown);
    lightbox.addEventListener("click", onKeywordClick);
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

    fetch(DATA_URL, { cache: "no-cache" })
        .then(function (res) {
            if (!res.ok) throw new Error("Could not load bits");
            return res.json();
        })
        .then(function (data) {
            state.bits = data.bits || data.results || data || [];
            renderFilters();
            renderGrid();
            const hash = decodeURIComponent((location.hash || "").replace(/^#bit=/, ""));
            if (hash && hash !== location.hash) openLightbox(hash);
        })
        .catch(function () {
            countEl.textContent = "The catalogue could not be loaded.";
        });
})();
