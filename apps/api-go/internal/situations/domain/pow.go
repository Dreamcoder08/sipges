package domain

import (
	"math"
	"math/big"
	"sync"
	"sync/atomic"
)

// HalfPow is JavaScript's 0.5 ** e (= 2 ** -e exactly), rounded to the nearest double. Node on
// Linux takes it from glibc's pow; Go's math.Pow differs from that in the last bit for about one
// input in eight (9,421 of the 72,180 values of every age 0–400 over every half-life 1–180),
// so the power is computed here with 160 bits and rounded once.
//
// glibc's pow is within 0.52 ULP, not always correctly rounded: on that grid 38 values still
// differ from Node by one bit (near-halfway cases). The score sums these terms and rounds to two
// decimals, so a one-bit difference shows only when the sum lies within a few ULP of a rounding
// boundary; the fixture test pins the realistic half-lives (1, 7, 13, 14, 30, 180) to Node.
func HalfPow(e float64) float64 {
	if v, ok := halfPowCache.Load(e); ok {
		return v.(float64)
	}
	v := exp2(-e)
	if halfPowSize.Add(1) <= maxHalfPowCache {
		halfPowCache.Store(e, v)
	}
	return v
}

// Ages are whole days within the project's window and half-lives whole days, so the distinct
// exponents are few; the bound only keeps unexpected inputs from growing the cache.
const maxHalfPowCache = 1 << 16

var (
	halfPowCache sync.Map
	halfPowSize  atomic.Int64
)

const precision = 160

// ln2 to 100 decimal places, more than precision needs.
var ln2, _, _ = big.ParseFloat("0.6931471805599453094172321214581765680755001343602552541206800094933936219696947156058633269964186875", 10, precision, big.ToNearestEven)

// exp2 is 2 ** y rounded once to the nearest double.
func exp2(y float64) float64 {
	switch {
	case math.IsNaN(y):
		return y
	case y > 1024:
		return math.Inf(1)
	case y < -1080:
		return 0
	}
	n := math.Floor(y)
	if y == n {
		return math.Ldexp(1, int(n))
	}
	// 2 ** f = exp(f · ln 2) by its Taylor series, with f = y - n in [0, 1) taken exactly (in
	// float64 the subtraction can round); the argument is below ln 2, so 60 terms reach well past
	// 2 ** -160.
	z := new(big.Float).SetPrec(precision).SetFloat64(y)
	z.Sub(z, new(big.Float).SetFloat64(n))
	z.Mul(z, ln2)
	sum := new(big.Float).SetPrec(precision).SetInt64(1)
	term := new(big.Float).SetPrec(precision).SetInt64(1)
	k := new(big.Float).SetPrec(precision)
	for i := int64(1); i < 60; i++ {
		term.Mul(term, z)
		term.Quo(term, k.SetInt64(i))
		sum.Add(sum, term)
	}
	sum.SetMantExp(sum, int(n))
	v, _ := sum.Float64()
	return v
}
