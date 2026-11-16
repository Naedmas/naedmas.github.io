(function (global) {
    const ALLOWED_EMAIL = "naedmas112@gmail.com";
    const firebaseConfig = {
        apiKey: "AIzaSyBgBh6tl0HSqWTeWxqll2Pd8vKKr-HV7-A",
        authDomain: "naedmas-ab1c9.firebaseapp.com",
        projectId: "naedmas-ab1c9",
        storageBucket: "naedmas-ab1c9.firebasestorage.app",
        messagingSenderId: "818829278172",
        appId: "1:818829278172:web:cebd2284efb823ae832d19"
    };

    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
    const auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    let accessDenied = false;

    function isAllowed(user) {
        return !!(user && user.email && user.email.toLowerCase() === ALLOWED_EMAIL);
    }

    function $(id) {
        return document.getElementById(id);
    }

    function show(el) {
        if (el) el.classList.remove("hidden");
    }

    function hide(el) {
        if (el) el.classList.add("hidden");
    }

    function initAuth(options) {
        const onAuthorized = options && options.onAuthorized;
        const authGate = $("authGate");
        const signInPanel = $("signInPanel");
        const appShell = $("appShell");
        const deniedBox = $("deniedMsg");
        const authError = $("authError");
        const googleBtn = $("googleBtn");
        const emailForm = $("emailForm");
        const emailInput = $("email");
        const passwordInput = $("password");
        const userInfo = $("userInfo");

        function hideGate() {
            hide(authGate);
        }

        function showSignIn() {
            hide(appShell);
            show(signInPanel);
            if (accessDenied) show(deniedBox);
            else hide(deniedBox);
        }

        function showApp(user) {
            accessDenied = false;
            hide(signInPanel);
            hide(deniedBox);
            hide(authError);
            if (authError) authError.textContent = "";
            if (userInfo) userInfo.textContent = user.email;
            show(appShell);
            if (typeof onAuthorized === "function") onAuthorized(user);
        }

        function showAuthError(message) {
            if (!authError) return;
            authError.textContent = message;
            show(authError);
        }

        function clearAuthError() {
            if (!authError) return;
            authError.textContent = "";
            hide(authError);
        }

        if (googleBtn) {
            googleBtn.addEventListener("click", async function () {
                clearAuthError();
                accessDenied = false;
                hide(deniedBox);
                try {
                    const provider = new firebase.auth.GoogleAuthProvider();
                    await auth.signInWithPopup(provider);
                } catch (err) {
                    if (err && (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request")) {
                        return;
                    }
                    showAuthError((err && err.message) || "Google sign-in failed.");
                }
            });
        }

        if (emailForm) {
            emailForm.addEventListener("submit", async function (event) {
                event.preventDefault();
                clearAuthError();
                accessDenied = false;
                hide(deniedBox);
                const email = ((emailInput && emailInput.value) || "").trim();
                const password = (passwordInput && passwordInput.value) || "";
                if (!email || !password) {
                    showAuthError("Enter email and password.");
                    return;
                }
                try {
                    await auth.signInWithEmailAndPassword(email, password);
                } catch (err) {
                    showAuthError("Invalid email or password.");
                }
            });
        }

        auth.onAuthStateChanged(function (user) {
            if (!user) {
                showSignIn();
                hideGate();
                return;
            }
            if (!isAllowed(user)) {
                accessDenied = true;
                auth.signOut();
                return;
            }
            showApp(user);
            hideGate();
        });

        global.logout = function logout() {
            if (confirm("Sign out?")) {
                accessDenied = false;
                auth.signOut();
            }
        };
    }

    global.NaedmasAuth = {
        auth: auth,
        ALLOWED_EMAIL: ALLOWED_EMAIL,
        isAllowed: isAllowed,
        initAuth: initAuth
    };
})(window);
