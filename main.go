package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var (
	clients    = make(map[*Client]bool)
	clientsMux sync.RWMutex
)

type SignalingMessage struct {
	Type      string          `json:"type"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

func broadcastToOthers(sender *Client, message []byte) {
	// mutex lock to prevent concurrent access to clients map
	clientsMux.RLock()
	defer clientsMux.RUnlock()

	for client := range clients {
		if client != sender {
			client.mu.Lock()
			err := client.conn.WriteMessage(websocket.TextMessage, message)
			client.mu.Unlock()

			if err != nil {
				log.Printf("Error broadcasting message: %v", err)
				continue
			}
		}
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	client := &Client{
		conn: conn,
	}

	clientsMux.Lock()
	clients[client] = true
	clientsMux.Unlock()

	log.Printf("New client connected. Total clients: %d", len(clients))

	defer func() {
		clientsMux.Lock()
		delete(clients, client)
		clientsMux.Unlock()
		conn.Close()
		log.Printf("Client disconnected. Total clients: %d", len(clients))
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var sigMsg SignalingMessage
		if err := json.Unmarshal(message, &sigMsg); err != nil {
			log.Printf("Error parsing message: %v", err)
			continue
		}

		switch sigMsg.Type {
		case "offer", "answer", "ice_candidate":
			broadcastToOthers(client, message)
		default:
			log.Printf("Unknown message type: %s", sigMsg.Type)
		}
	}
}

func main() {
	http.HandleFunc("/ws", handleWebSocket)

	port := ":8080"
	log.Printf("Starting signaling server on %s", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
