package handlers

import (
	"log"
	"net/http"
	"sendit/pkg/signaling"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	client := signaling.NewClient(conn) // create a new client
	signaling.AddClient(client)         // register the client

	defer func() {
		signaling.RemoveClient(client) // reemove client on disconnect
		conn.Close()
	}()

	signaling.ListenClient(client) // listen for messages from the client
}
