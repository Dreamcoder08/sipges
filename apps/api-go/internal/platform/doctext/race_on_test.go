//go:build race

package doctext

// raceDetector: its shadow memory doubles the peak of a read, so the peak says nothing there.
const raceDetector = true
