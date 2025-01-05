package signaling

import (
	"log"

	"github.com/gorilla/websocket"
)

func BroadcastToOthers(sender *Client, message []byte) {
	clientsMux.RLock()
	defer clientsMux.RUnlock()

	for client := range clients {
		if client != sender {
			client.mu.Lock()
			err := client.conn.WriteMessage(websocket.TextMessage, message)
			client.mu.Unlock()

			if err != nil {
				log.Printf("Error broadcasting message: %v", err)
			}
		}
	}
}
