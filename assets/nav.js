(function () {
    const nav = document.querySelector(".site-nav");
    const btn = document.querySelector(".nav-toggle");
    const links = document.getElementById("site-nav-links");
    if (!nav || !btn || !links) return;

    function isOpen() {
        return btn.getAttribute("aria-expanded") === "true";
    }

    function setOpen(open) {
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.setAttribute("aria-label", open ? "Close the chapter orders" : "Open the chapter orders");
        nav.classList.toggle("is-open", open);
        document.body.classList.toggle("nav-open", open);
    }

    btn.addEventListener("click", function () {
        setOpen(!isOpen());
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && isOpen()) {
            setOpen(false);
            btn.focus();
        }
    });

    links.addEventListener("click", function (event) {
        if (event.target.closest("a") && isOpen()) setOpen(false);
    });

    window.addEventListener("resize", function () {
        if (window.matchMedia("(min-width: 1201px)").matches && isOpen()) {
            setOpen(false);
        }
    });
})();
