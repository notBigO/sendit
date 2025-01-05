package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
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
	room string
	mu   sync.Mutex
}

type Room struct {
	clients map[*Client]bool
	mu      sync.RWMutex
}

var (
	rooms    = make(map[string]*Room)
	roomsMux sync.RWMutex
)

type SignalingMessage struct {
	Type      string          `json:"type"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Room      string          `json:"room,omitempty"`
}

func createRoom() string {
	roomID := uuid.New().String()

	roomsMux.Lock()
	rooms[roomID] = &Room{
		clients: make(map[*Client]bool),
	}
	roomsMux.Unlock()

	return roomID
}

func broadcastToRoom(sender *Client, message []byte) {
	roomsMux.RLock()
	room, exists := rooms[sender.room]
	roomsMux.RUnlock()

	if !exists {
		return
	}

	room.mu.RLock()
	defer room.mu.RUnlock()

	for client := range room.clients {
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
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		http.Error(w, "Room ID is required", http.StatusBadRequest)
		return
	}

	roomsMux.RLock()
	room, exists := rooms[roomID]
	roomsMux.RUnlock()

	if !exists {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	client := &Client{
		conn: conn,
		room: roomID,
	}

	room.mu.Lock()
	room.clients[client] = true
	room.mu.Unlock()

	log.Printf("New client connected to room %s. Total clients in room: %d", roomID, len(room.clients))

	defer func() {
		room.mu.Lock()
		delete(room.clients, client)
		room.mu.Unlock()

		// If room is empty, delete it
		if len(room.clients) == 0 {
			roomsMux.Lock()
			delete(rooms, roomID)
			roomsMux.Unlock()
		}

		conn.Close()
		log.Printf("Client disconnected from room %s. Total clients in room: %d", roomID, len(room.clients))
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
			broadcastToRoom(client, message)
		default:
			log.Printf("Unknown message type: %s", sigMsg.Type)
		}
	}
}

func handleCreateRoom(w http.ResponseWriter, r *http.Request) {

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	if r.Method == http.MethodOptions {

		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomID := createRoom()

	response := map[string]string{
		"roomId": roomID,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
func main() {
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/create-room", handleCreateRoom)

	port := ":8080"
	log.Printf("Starting signaling server on %s", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
