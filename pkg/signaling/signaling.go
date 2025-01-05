package signaling

import (
	"encoding/json"
	"log"
	"sync"
)

var (
	clients    = make(map[*Client]bool)
	clientsMux sync.RWMutex
)

// add a client to the global client map.
func AddClient(client *Client) {
	clientsMux.Lock()
	defer clientsMux.Unlock()
	clients[client] = true
	log.Printf("New client connected. Total clients: %d", len(clients))
}

// remove a client from the global client map.
func RemoveClient(client *Client) {
	clientsMux.Lock()
	defer clientsMux.Unlock()
	delete(clients, client)
	log.Printf("Client disconnected. Total clients: %d", len(clients))
}

// listen for messages from a client.
func ListenClient(client *Client) {
	for {
		_, message, err := client.conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket error: %v", err)
			break
		}

		var sigMsg SignalingMessage
		if err := json.Unmarshal(message, &sigMsg); err != nil {
			log.Printf("Error parsing message: %v", err)
			continue
		}

		switch sigMsg.Type {
		case "offer", "answer", "ice_candidate":
			BroadcastToOthers(client, message)
		default:
			log.Printf("Unknown message type: %s", sigMsg.Type)
		}
	}
}
