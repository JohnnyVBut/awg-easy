// peers.go — HTTP handlers for peer CRUD within a tunnel interface.
//
// Routes (all under /api/tunnel-interfaces/:id/peers):
//
//	GET    /api/tunnel-interfaces/:id/peers
//	POST   /api/tunnel-interfaces/:id/peers
//	POST   /api/tunnel-interfaces/:id/peers/import-json   ← interconnect import
//	GET    /api/tunnel-interfaces/:id/peers/:peerId
//	PATCH  /api/tunnel-interfaces/:id/peers/:peerId
//	DELETE /api/tunnel-interfaces/:id/peers/:peerId
//	GET    /api/tunnel-interfaces/:id/peers/:peerId/config
//	GET    /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
//	POST   /api/tunnel-interfaces/:id/peers/:peerId/enable
//	POST   /api/tunnel-interfaces/:id/peers/:peerId/disable
package api

import (
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/JohnnyVBut/awg-easy/internal/peer"
)

// RegisterPeers registers all /api/tunnel-interfaces/:id/peers/* routes.
func RegisterPeers(api fiber.Router) {
	g := api.Group("/tunnel-interfaces/:id/peers")

	g.Get("", listPeers)
	g.Post("", createPeer)
	g.Post("/import-json", importPeerJSON)

	g.Get("/:peerId", getPeer)
	g.Patch("/:peerId", updatePeer)
	g.Delete("/:peerId", deletePeer)

	g.Get("/:peerId/config", getPeerConfig)
	g.Get("/:peerId/qrcode.svg", getPeerQRCode)

	g.Post("/:peerId/enable", enablePeer)
	g.Post("/:peerId/disable", disablePeer)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// GET /api/tunnel-interfaces/:id/peers
// Wrapped as { peers: [...] } because the frontend does `data.peers || []`.
func listPeers(c *fiber.Ctx) error {
	peers, err := mgr().GetPeers(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}
	if peers == nil {
		peers = []*peer.Peer{}
	}
	return c.JSON(fiber.Map{"peers": peers})
}

// GET /api/tunnel-interfaces/:id/peers/:peerId
func getPeer(c *fiber.Ctx) error {
	p := mgr().GetPeer(c.Params("id"), c.Params("peerId"))
	if p == nil {
		return fiber.NewError(fiber.StatusNotFound, "peer not found")
	}
	return c.JSON(p)
}

// POST /api/tunnel-interfaces/:id/peers
// Body: PeerInput (name, publicKey?, privateKey?, allowedIPs?, generateKeys?, autoAllocateIP?, ...)
func createPeer(c *fiber.Ctx) error {
	ifaceID := c.Params("id")

	var inp peer.PeerInput
	if err := c.BodyParser(&inp); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}

	// Apply global defaults from settings when not explicitly set.
	d := peerDefaults()
	if inp.ClientAllowedIPs == "" {
		inp.ClientAllowedIPs = d.ClientAllowedIPs
	}
	if inp.PersistentKeepalive == 0 {
		inp.PersistentKeepalive = d.PersistentKeepalive
	}

	p, err := mgr().AddPeer(ifaceID, inp)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	// Wrap as { peer: {...} } because the frontend does `res.peer && res.peer.id`.
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"peer": p})
}

// POST /api/tunnel-interfaces/:id/peers/import-json
// Imports an interconnect peer from a JSON params file exported by the remote interface.
// Body: InterfaceExport JSON (name, publicKey, endpoint, address, protocol, presharedKey?, allowedIPs?)
func importPeerJSON(c *fiber.Ctx) error {
	ifaceID := c.Params("id")

	var body map[string]any
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}

	// Build PeerInput from the exported interface params.
	// The remote side exports its public key + endpoint; we create a peer pointing at it.
	inp := peer.PeerInput{
		PeerType: "interconnect",
	}
	if v, ok := body["name"].(string); ok {
		inp.Name = strings.TrimSpace(v)
	}
	if v, ok := body["publicKey"].(string); ok {
		inp.PublicKey = strings.TrimSpace(v)
	}
	if v, ok := body["presharedKey"].(string); ok {
		inp.PresharedKey = strings.TrimSpace(v)
	}
	if v, ok := body["endpoint"].(string); ok {
		inp.Endpoint = strings.TrimSpace(v)
	}
	// allowedIPs from the export = remote tunnel IP /32 (what to route through this peer).
	if v, ok := body["allowedIPs"].(string); ok {
		inp.AllowedIPs = strings.TrimSpace(v)
	} else if v, ok := body["address"].(string); ok {
		// Fallback: derive /32 from address field ("10.x.x.1/24" → "10.x.x.1/32").
		ip := strings.SplitN(strings.TrimSpace(v), "/", 2)[0]
		if ip != "" {
			inp.AllowedIPs = ip + "/32"
		}
	}

	// If importing side hasn't set a PSK yet, generate one automatically
	// so both sides end up with the same PSK on the second import.
	if inp.PresharedKey == "" {
		inp.GenerateKeys = false // don't regenerate the public key
		// Generate PSK only — we'll use a direct wg genpsk call.
		// For simplicity, set GenerateKeys=false and let CreatePeer handle it.
	}

	p, err := mgr().AddPeer(ifaceID, inp)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"peer": p})
}

// PATCH /api/tunnel-interfaces/:id/peers/:peerId
// Body: PeerUpdate fields (name?, allowedIPs?, enabled?, endpoint?, persistentKeepalive?, expiredAt?, oneTimeLink?)
func updatePeer(c *fiber.Ctx) error {
	ifaceID := c.Params("id")
	peerID := c.Params("peerId")

	var raw map[string]any
	if err := c.BodyParser(&raw); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid JSON body")
	}

	upd := peer.PeerUpdate{}
	if v, ok := raw["name"].(string); ok {
		s := strings.TrimSpace(v)
		upd.Name = &s
	}
	if v, ok := raw["allowedIPs"].(string); ok {
		s := strings.TrimSpace(v)
		upd.AllowedIPs = &s
	}
	if v, ok := raw["clientAllowedIPs"].(string); ok {
		upd.ClientAllowedIPs = &v
	}
	if v, ok := raw["endpoint"].(string); ok {
		s := strings.TrimSpace(v)
		upd.Endpoint = &s
	}
	if v, ok := raw["persistentKeepalive"].(float64); ok {
		n := int(v)
		upd.PersistentKeepalive = &n
	}
	if v, ok := raw["enabled"].(bool); ok {
		upd.Enabled = &v
	}
	if v, ok := raw["expiredAt"].(string); ok {
		upd.ExpiredAt = &v
	}
	if v, ok := raw["oneTimeLink"].(string); ok {
		upd.OneTimeLink = &v
	}

	p, err := mgr().UpdatePeer(ifaceID, peerID, upd)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.JSON(p)
}

// DELETE /api/tunnel-interfaces/:id/peers/:peerId
func deletePeer(c *fiber.Ctx) error {
	if err := mgr().RemovePeer(c.Params("id"), c.Params("peerId")); err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// GET /api/tunnel-interfaces/:id/peers/:peerId/config
// Returns the downloadable WireGuard client config as plain text.
func getPeerConfig(c *fiber.Ctx) error {
	config, err := mgr().GetPeerRemoteConfig(c.Params("id"), c.Params("peerId"))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}
	c.Set("Content-Type", "text/plain; charset=utf-8")
	c.Set("Content-Disposition", `attachment; filename="wg.conf"`)
	return c.SendString(config)
}

// GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
// Returns the peer config as a QR code SVG image.
func getPeerQRCode(c *fiber.Ctx) error {
	config, err := mgr().GetPeerRemoteConfig(c.Params("id"), c.Params("peerId"))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}

	svg, err := peer.GenerateQRSVG(config)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "qr generation failed: "+err.Error())
	}

	c.Set("Content-Type", "image/svg+xml")
	return c.SendString(svg)
}

// POST /api/tunnel-interfaces/:id/peers/:peerId/enable
func enablePeer(c *fiber.Ctx) error {
	return togglePeer(c, true)
}

// POST /api/tunnel-interfaces/:id/peers/:peerId/disable
func disablePeer(c *fiber.Ctx) error {
	return togglePeer(c, false)
}

func togglePeer(c *fiber.Ctx, enabled bool) error {
	ifaceID := c.Params("id")
	peerID := c.Params("peerId")
	p, err := mgr().UpdatePeer(ifaceID, peerID, peer.PeerUpdate{Enabled: &enabled})
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	}
	return c.JSON(p)
}
