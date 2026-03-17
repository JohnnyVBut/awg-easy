// auth.go — session-based authentication middleware and login/logout endpoints.
//
// Mirrors the auth logic from Server.js:
//   - If PASSWORD_HASH is empty → server runs in open mode (all requests pass)
//   - POST /api/session   → verify password, create session
//   - GET  /api/session   → return current auth state
//   - DELETE /api/session → destroy session (logout)
//   - AuthMiddleware      → protects all other /api/* routes
//
// Two authentication paths (checked in order):
//  1. Session cookie — set after successful POST /api/session
//  2. Authorization header — raw password (not Bearer, not Basic) compared with bcrypt
//     Used by scripts / curl that cannot maintain cookies.
//
// Session storage: in-memory (Fiber built-in).
// Sessions do not survive container restart — this is intentional for Phase 1.
package api

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
	"golang.org/x/crypto/bcrypt"
)

// ── Package-level auth state ──────────────────────────────────────────────────

var (
	authStore        *session.Store
	authPasswordHash string  // bcrypt hash from PASSWORD_HASH env; "" = open mode
	authRequired     bool    // true when passwordHash != ""
)

// rememberMaxAge is the session lifetime when "remember me" is checked.
const rememberMaxAge = 30 * 24 * time.Hour // 30 days

// defaultSessionAge is the default session lifetime (browser-session if 0, or explicit).
// Using 24 h as a safe default so sessions expire on container restart via max-age.
const defaultSessionAge = 24 * time.Hour

// InitAuth initialises the auth subsystem.
// passwordHash is the value of the PASSWORD_HASH env var (bcrypt hash).
// Call once from main() before registering routes.
func InitAuth(passwordHash string) {
	authPasswordHash = strings.TrimSpace(passwordHash)
	authRequired = authPasswordHash != ""

	authStore = session.New(session.Config{
		Expiration: defaultSessionAge,
		KeyLookup:  "cookie:session_id",
		CookieHTTPOnly: true,
		CookieSameSite: "Lax",
	})
}

// ── Middleware ────────────────────────────────────────────────────────────────

// AuthMiddleware protects API routes.
// Passes through when:
//  1. No password is configured (open mode).
//  2. Request has a valid session cookie.
//  3. Authorization header contains the correct raw password.
//
// Returns 401 JSON otherwise.
func AuthMiddleware(c *fiber.Ctx) error {
	if !authRequired {
		return c.Next()
	}

	// 1. Session cookie check.
	if authStore != nil {
		sess, err := authStore.Get(c)
		if err == nil && sess.Get("authenticated") == true {
			return c.Next()
		}
	}

	// 2. Authorization header check (raw password, no scheme prefix).
	if hdr := c.Get("Authorization"); hdr != "" {
		if isPasswordValid(hdr, authPasswordHash) {
			return c.Next()
		}
	}

	return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
		"error": "Unauthorized",
	})
}

// ── Routes ────────────────────────────────────────────────────────────────────

// RegisterAuth registers the session endpoints on the given router group.
// These routes are intentionally NOT behind AuthMiddleware (they are the login UI).
//
//	GET    /api/session  — current session state
//	POST   /api/session  — login
//	DELETE /api/session  — logout
func RegisterAuth(api fiber.Router) {
	// GET /api/session — returns current authentication state.
	// Used by the frontend on load to decide whether to show the login screen.
	api.Get("/session", func(c *fiber.Ctx) error {
		if !authRequired {
			return c.JSON(fiber.Map{
				"authenticated":    true,
				"requiresPassword": false,
			})
		}

		authenticated := false
		if authStore != nil {
			sess, err := authStore.Get(c)
			if err == nil {
				authenticated = sess.Get("authenticated") == true
			}
		}

		return c.JSON(fiber.Map{
			"authenticated":    authenticated,
			"requiresPassword": authRequired,
		})
	})

	// POST /api/session — verify password and create session.
	// Body: { "password": "...", "remember": true/false }
	api.Post("/session", func(c *fiber.Ctx) error {
		if !authRequired {
			// No password configured — login endpoint should not be called.
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "No password is configured",
			})
		}

		var body struct {
			Password string `json:"password"`
			Remember bool   `json:"remember"`
		}
		if err := c.BodyParser(&body); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
		}

		if !isPasswordValid(body.Password, authPasswordHash) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "Invalid password",
			})
		}

		sess, err := authStore.Get(c)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "session error")
		}

		sess.Set("authenticated", true)

		// "Remember me" → long-lived cookie; otherwise use the store default (24 h).
		if body.Remember {
			sess.SetExpiry(rememberMaxAge)
		}

		if err := sess.Save(); err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "session save error")
		}

		return c.JSON(fiber.Map{"authenticated": true})
	})

	// DELETE /api/session — destroy the session (logout).
	api.Delete("/session", func(c *fiber.Ctx) error {
		if authStore != nil {
			sess, err := authStore.Get(c)
			if err == nil {
				_ = sess.Destroy()
			}
		}
		return c.JSON(fiber.Map{"authenticated": false})
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// isPasswordValid returns true if password matches the bcrypt hash.
// Returns false for empty or non-string passwords (mirrors JS behaviour).
func isPasswordValid(password, hash string) bool {
	if password == "" || hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
