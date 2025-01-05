package signaling

import (
	"sync"

	"github.com/gorilla/websocket"
)

type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

// init a new client
func NewClient(conn *websocket.Conn) *Client {
	return &Client{
		conn: conn,
	}
}
