// Package bank has a struct type with methods, which goesm's JS calling ABI
// hands to JavaScript as the Go object itself (a handle).
package bank

import "strconv"

type Account struct {
	Owner   string   `json:"owner"`
	Balance int      `json:"balance"`
	Tags    []string `json:"tags"`
	Parent  *Account `json:"parent"`
	note    string
}

func New(owner string, balance int, parent *Account) *Account {
	return &Account{Owner: owner, Balance: balance, Tags: []string{"a", "b"}, Parent: parent, note: "private"}
}

func (a *Account) Deposit(n int) { a.Balance += n }

func (a *Account) Label() string { return a.Owner + ":" + strconv.Itoa(a.Balance) }
