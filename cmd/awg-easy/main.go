// AWG-Easy 3.0 — Go/Fiber entry point.
// Phase 1: HTTP skeleton + static file serving.
// Managers (tunnel, routing, nat, firewall, gateway) are added module by module.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	fiberlog "github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"

	"github.com/JohnnyVBut/awg-easy/internal/api"
	"github.com/JohnnyVBut/awg-easy/internal/db"
)

// Config holds all runtime configuration resolved from flags and ENV.
// Flag takes priority over ENV (standard Go service pattern).
type Config struct {
	DataDir      string // --data-dir / DATA_DIR
	Port         int    // --port / PORT         (TCP, Web UI)
	WGPort       int    // --wg-port / WG_PORT   (UDP, WireGuard default)
	Host         string // --host / WG_HOST      (required)
	PasswordHash string // --password-hash / PASSWORD_HASH
	Debug        bool   // --debug / DEBUG
}

func main() {
	cfg := parseConfig()

	app := fiber.New(fiber.Config{
		AppName:               "AWG-Easy 3.0",
		DisableStartupMessage: true, // мы сами печатаем стартовое сообщение
		ReadTimeout:           30 * time.Second,
		WriteTimeout:          30 * time.Second,
		IdleTimeout:           60 * time.Second,
		ErrorHandler:          errorHandler,
	})

	// ── Middleware ────────────────────────────────────────────────────────────

	// Panic recovery — превращает панику в HTTP 500 (не роняет сервер).
	app.Use(recover.New())

	// Request logging — только в debug режиме.
	if cfg.Debug {
		app.Use(fiberlog.New(fiberlog.Config{
			Format: "[${time}] ${method} ${path} → ${status} (${latency})\n",
		}))
	}

	// ── Static files ──────────────────────────────────────────────────────────
	// Serve frontend from www/ directory.
	// Phase 2: заменить на embed.FS для ISO (полностью offline).
	app.Static("/", "./www", fiber.Static{
		Compress: true,  // gzip для JS/CSS
		Index:    "index.html",
		Browse:   false,
	})

	// ── API routes ────────────────────────────────────────────────────────────
	apiGroup := app.Group("/api")

	// Healthcheck
	apiGroup.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":  "ok",
			"version": "3.0.0-alpha",
			"host":    cfg.Host,
		})
	})

	// Settings + Templates
	api.RegisterSettings(apiGroup)

	// TODO: по мере реализации модулей добавлять здесь:
	// api.RegisterInterfaces(apiGroup)
	// api.RegisterRouting(apiGroup)
	// api.RegisterNat(apiGroup)
	// api.RegisterFirewall(apiGroup)
	// api.RegisterGateways(apiGroup)

	// ── Database ──────────────────────────────────────────────────────────────
	if err := db.Init(cfg.DataDir); err != nil {
		log.Fatalf("db init: %v", err)
	}
	defer db.Close()

	// ── Manager initialization (FIX-13: строгий порядок) ─────────────────────
	// TODO: раскомментировать по мере реализации модулей:
	//
	// if err := settings.Init(cfg.DataDir); err != nil {
	//     log.Fatalf("settings init: %v", err)
	// }
	// if err := tunnel.InitInterfaceManager(cfg.DataDir); err != nil {
	//     log.Fatalf("interface manager init: %v", err)
	// }
	// rm, err := routing.Init(cfg.DataDir)
	// if err != nil { log.Fatalf("route manager init: %v", err) }
	// if err := rm.RestoreAll(); err != nil {
	//     log.Printf("route restore warning: %v", err)
	// }
	// if err := nat.Init(cfg.DataDir); err != nil {
	//     log.Fatalf("nat manager init: %v", err)
	// }
	// if err := firewall.Init(cfg.DataDir); err != nil {
	//     log.Fatalf("firewall init: %v", err)
	// }
	// if err := gateway.Init(cfg.DataDir); err != nil {
	//     log.Fatalf("gateway init: %v", err)
	// }

	// ── Start ─────────────────────────────────────────────────────────────────
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("AWG-Easy 3.0 | host=%s | port=%d (tcp) | wg-port=%d (udp) | data=%s | debug=%v",
		cfg.Host, cfg.Port, cfg.WGPort, cfg.DataDir, cfg.Debug)

	// Запуск в горутине чтобы не блокировать graceful shutdown ниже.
	go func() {
		if err := app.Listen(addr); err != nil {
			log.Fatalf("server: %v", err)
		}
	}()

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Println("Shutting down gracefully...")
	if err := app.Shutdown(); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("Bye.")
}

// parseConfig resolves configuration from CLI flags with ENV fallback.
// Flag always wins over ENV — standard pattern for Go services.
func parseConfig() Config {
	var cfg Config

	flag.StringVar(&cfg.DataDir, "data-dir",
		envStr("DATA_DIR", "/etc/wireguard/data"),
		"Path to data directory (JSON storage)")

	flag.IntVar(&cfg.Port, "port",
		envInt("PORT", 8888),
		"Web UI listen port (TCP)")

	flag.IntVar(&cfg.WGPort, "wg-port",
		envInt("WG_PORT", 555),
		"Default WireGuard/AWG listen port (UDP) for new interfaces")

	flag.StringVar(&cfg.Host, "host",
		envStr("WG_HOST", ""),
		"Server public hostname or IP address (required)")

	flag.StringVar(&cfg.PasswordHash, "password-hash",
		envStr("PASSWORD_HASH", ""),
		"bcrypt password hash for Web UI login")

	flag.BoolVar(&cfg.Debug, "debug",
		envBool("DEBUG", false),
		"Enable debug request logging")

	flag.Parse()

	if cfg.Host == "" {
		log.Fatal("WG_HOST env or --host flag is required")
	}

	return cfg
}

// errorHandler converts errors to JSON responses.
// *fiber.Error (e.g. createError({ status: 400, message: "..." })) → proper status code.
// Everything else → 500.
func errorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	msg := "Internal Server Error"

	if e, ok := err.(*fiber.Error); ok {
		code = e.Code
		msg = e.Message
	}

	return c.Status(code).JSON(fiber.Map{"error": msg})
}

// ── ENV helpers ───────────────────────────────────────────────────────────────

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
