// routing.go — HTTP handlers for RouteManager.
//
// Routes:
//
//	GET    /api/routing/table        ← kernel routes for a given table
//	GET    /api/routing/tables       ← list of routing tables (from ip rule show)
//	GET    /api/routing/test         ← route lookup / PBR trace
//	GET    /api/routing/routes       ← static routes (SQLite)
//	POST   /api/routing/routes
//	PATCH  /api/routing/routes/:id
//	DELETE /api/routing/routes/:id
package api

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/JohnnyVBut/awg-easy/internal/routing"
)

// RegisterRouting registers all /api/routing/* routes.
func RegisterRouting(api fiber.Router) {
	g := api.Group("/routing")

	g.Get("/table", getKernelRoutes)
	g.Get("/tables", getRoutingTables)
	g.Get("/test", testRoute)

	g.Get("/routes", getStaticRoutes)
	g.Post("/routes", createRoute)
	g.Patch("/routes/:id", updateRoute)
	g.Delete("/routes/:id", deleteRoute)
}

// ── Kernel views ──────────────────────────────────────────────────────────────

// GET /api/routing/table?table=main
// Wrapped as { routes: [...] } because the frontend does `res.routes || []`.
func getKernelRoutes(c *fiber.Ctx) error {
	table := c.Query("table", "main")
	routes, err := routing.Get().GetKernelRoutes(table)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if routes == nil {
		routes = []routing.KernelRoute{}
	}
	return c.JSON(fiber.Map{"routes": routes})
}

// GET /api/routing/tables
// Wrapped as { tables: [...] } because the frontend does `res.tables || []`.
func getRoutingTables(c *fiber.Ctx) error {
	tables, err := routing.Get().GetRoutingTables()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if tables == nil {
		tables = []routing.RoutingTable{}
	}
	return c.JSON(fiber.Map{"tables": tables})
}

// GET /api/routing/test?ip=8.8.8.8&src=10.8.0.2&mark=1000
// Returns route lookup result with optional PBR trace.
// FIX-15: kernel errors (e.g. "RTNETLINK: Invalid argument") returned as HTTP 400.
func testRoute(c *fiber.Ctx) error {
	ip := c.Query("ip")
	if ip == "" {
		return fiber.NewError(fiber.StatusBadRequest, "ip query parameter is required")
	}
	src := c.Query("src")   // optional source IP for PBR trace
	markStr := c.Query("mark") // optional fwmark (integer string)

	// Parse optional mark integer.
	var mark *int
	if markStr != "" {
		n, err := strconv.Atoi(markStr)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "mark must be an integer")
		}
		mark = &n
	}

	result, err := routing.Get().TestRoute(ip, src, mark)
	if err != nil {
		// FIX-15: kernel errors start with "ip route:" → HTTP 400 with detail.
		if strings.HasPrefix(err.Error(), "ip route:") {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	// Wrap as { result, matchedRule, steps } because the frontend does:
	//   res.result, res.matchedRule || null, res.steps || []
	return c.JSON(fiber.Map{
		"result":      result,
		"matchedRule": nil,
		"steps":       []fiber.Map{},
	})
}

// ── Static routes CRUD ────────────────────────────────────────────────────────

// GET /api/routing/routes
// Wrapped as { routes: [...] } because the frontend does `res.routes || []`.
func getStaticRoutes(c *fiber.Ctx) error {
	routes, err := routing.Get().GetRoutes()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if routes == nil {
		routes = []routing.Route{}
	}
	return c.JSON(fiber.Map{"routes": routes})
}

// POST /api/routing/routes
// Body: { destination, gateway?, dev?, metric?, table?, description?, enabled? }
func createRoute(c *fiber.Ctx) error {
	var inp routing.Route
	if err := c.BodyParser(&inp); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}
	r, err := routing.Get().AddRoute(inp)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(r)
}

// PATCH /api/routing/routes/:id
// Supports full update OR toggle: { enabled: bool }
func updateRoute(c *fiber.Ctx) error {
	id := c.Params("id")
	var raw map[string]any
	if err := c.BodyParser(&raw); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}

	// Toggle shortcut: PATCH { enabled: bool }
	if enabled, ok := raw["enabled"].(bool); ok && len(raw) == 1 {
		r, err := routing.Get().ToggleRoute(id, enabled)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		return c.JSON(r)
	}

	// Full update — re-parse into Route struct.
	var upd routing.Route
	if err := c.BodyParser(&upd); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}
	r, err := routing.Get().UpdateRoute(id, upd)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.JSON(r)
}

// DELETE /api/routing/routes/:id
func deleteRoute(c *fiber.Ctx) error {
	if err := routing.Get().DeleteRoute(c.Params("id")); err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}
	return c.SendStatus(fiber.StatusNoContent)
}
