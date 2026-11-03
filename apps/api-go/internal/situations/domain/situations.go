//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import (
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Situations: records that share a topic, an actor or a recorded territory within the project's
// window, weighted by recency (docs/adr/0020 §2-3), as situations.ts computes them. JSON tags are
// the HTTP shape of situations-routes.ts.

// Citation names one record of a situation.
type Citation struct {
	Module string `json:"module"`
	ID     string `json:"id"`
	Title  Text16 `json:"title"`
	Date   string `json:"date"`
}

// Reason explains part of a situation, citing "module:id" records.
type Reason struct {
	Text    string   `json:"text"`
	Records []string `json:"records"`
}

// Lesson is a lesson the team recorded about the same territory, topic or actor.
type Lesson struct {
	ID      string `json:"id"`
	Date    string `json:"date"`
	Learned string `json:"learned"`
}

// Situation is one group of related records.
type Situation struct {
	Key             string     `json:"key"`
	Kind            string     `json:"kind"`
	Label           string     `json:"label"`
	Level           string     `json:"level"`
	Score           float64    `json:"score"`
	Trend           string     `json:"trend"`
	Summary         string     `json:"summary"`
	Reasons         []Reason   `json:"reasons"`
	Recommendations []string   `json:"recommendations"`
	Records         []Citation `json:"records"`
	Actors          []string   `json:"actors"`
	Territories     []string   `json:"territories"`
	Topics          []string   `json:"topics"`
	LastDate        string     `json:"last_date"`
	Lessons         []Lesson   `json:"lessons"`
}

// NamedCount is a name and how many records carry it.
type NamedCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// TopicCount is a repeated narrative topic.
type TopicCount struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Recent int    `json:"recent"`
}

// Tone is the share of negative tone now and before.
type Tone struct {
	Now  float64 `json:"now"`
	Then float64 `json:"then"`
}

// NarrativeOverview is narratives and media at a glance.
type NarrativeOverview struct {
	Total     int          `json:"total"`
	Recent    int          `json:"recent"`
	Topics    []TopicCount `json:"topics"`
	Platforms []NamedCount `json:"platforms"`
	Tone      *Tone        `json:"tone"`
}

// Report is findSituations' result with the lessons attached.
type Report struct {
	Situations []Situation
	Narratives NarrativeOverview
	// Undated counts records that could join a situation but carry no usable date.
	Undated    int
	Considered int
}

var kindLabel = map[string]string{"tema": "el tema", "actor": "el actor", "territorio": "el territorio"}

const (
	recentDays    = 7
	baselineWeeks = 4
	maxSituations = 30
	maxListed     = 3
)

func round2(n float64) float64 { return RoundJS(n*100) / 100 }

// toNumber is JavaScript's ToNumber for the decoded JSON values settings hold.
func toNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		t := TrimJS(x)
		if t == "" {
			return 0
		}
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f
		}
		return math.NaN()
	}
	if f, ok := Number(v); ok {
		return f
	}
	return math.NaN()
}

// template is `${value}` for a decoded JSON value.
func template(v any) string {
	if v == nil {
		return "null"
	}
	return JSString(v)
}

// ListNames is listNames(): "A", "A y B", "A, B y C", with "y N más" past three.
func ListNames(names []string) string {
	shown := names[:min(len(names), maxListed)]
	items := slices.Clone(shown)
	if rest := len(names) - len(shown); rest > 0 {
		items = append(items, strconv.Itoa(rest)+" más")
	}
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " y " + items[len(items)-1]
}

// counted groups values by their folded form (the first spelling names it), most frequent first.
func counted(values []string) []NamedCount {
	index := map[string]int{}
	var out []NamedCount
	for _, v := range values {
		key := Fold(v)
		if i, ok := index[key]; ok {
			out[i].Count++
			continue
		}
		index[key] = len(out)
		out = append(out, NamedCount{Name: v, Count: 1})
	}
	slices.SortStableFunc(out, func(a, b NamedCount) int {
		if a.Count != b.Count {
			return b.Count - a.Count
		}
		if Less16(a.Name, b.Name) {
			return -1
		}
		return 1
	})
	return out
}

func levelIndex(level string) int { return slices.Index(Levels, level) }

func levelFor(score float64, thresholds map[string]any) string {
	switch {
	case score >= toNumber(thresholds["Rojo"]):
		return "Rojo"
	case score >= toNumber(thresholds["Naranja"]):
		return "Naranja"
	case score >= toNumber(thresholds["Amarillo"]):
		return "Amarillo"
	}
	return "Verde"
}

type trend struct {
	name   string
	recent int
	weekly float64
}

func trendOf(signals []Signal) trend {
	recent, before := 0, 0
	for _, s := range signals {
		if s.AgeDays < recentDays {
			recent++
		} else if s.AgeDays < recentDays*(baselineWeeks+1) {
			before++
		}
	}
	weekly := float64(before) / baselineWeeks
	name := "estable"
	if recent >= 2 && float64(recent) > weekly*1.5 {
		name = "en aumento"
	} else if recent == 0 && before > 0 {
		name = "en descenso"
	}
	return trend{name, recent, round2(weekly)}
}

func isNegative(tone string) bool {
	for _, w := range []string{"negativ", "critic", "hostil", "adverso"} {
		if strings.Contains(tone, w) {
			return true
		}
	}
	return false
}

type toneShift struct {
	now, then float64
	recent    []Signal
}

// shiftOfTone is toneShift(): negative share among dated narratives, the last sixth of the window
// against the rest, when it moved by 25 points or more.
func shiftOfTone(signals []Signal, windowDays float64) *toneShift {
	split := windowDays / 6
	var recent, earlier []Signal
	for _, s := range signals {
		if s.Module != "Narrativas" || s.Tone == "" {
			continue
		}
		if float64(s.AgeDays) < split {
			recent = append(recent, s)
		} else if float64(s.AgeDays) >= split {
			earlier = append(earlier, s)
		}
	}
	if len(recent) < 2 || len(earlier) < 1 {
		return nil
	}
	share := func(list []Signal) float64 {
		n := 0
		for _, s := range list {
			if isNegative(s.Tone) {
				n++
			}
		}
		return RoundJS(float64(n*100) / float64(len(list)))
	}
	now, then := share(recent), share(earlier)
	if math.Abs(now-then) < 25 {
		return nil
	}
	return &toneShift{now, then, recent}
}

func cite(signals []Signal) []string {
	out := make([]string, 0, len(signals))
	for _, s := range signals {
		out = append(out, s.Module+":"+s.ID)
	}
	return out
}

func filterSignals(signals []Signal, keep func(Signal) bool) []Signal {
	var out []Signal
	for _, s := range signals {
		if keep(s) {
			out = append(out, s)
		}
	}
	return out
}

var recommendationOrder = []string{
	"inmediata", "reunion", "contactar", "seguimiento", "monitoreo", "narrativas", "buzon", "verificar",
}

func recommend(level, trendName string, signals []Signal, actors []string, texts map[string]string) []string {
	has := func(module string) bool {
		return slices.ContainsFunc(signals, func(s Signal) bool { return s.Module == module })
	}
	rank := levelIndex(level)
	when := map[string]bool{
		"inmediata":   level == "Rojo",
		"reunion":     rank >= 2,
		"contactar":   len(actors) > 0 && rank >= 1,
		"seguimiento": has("Demandas") || has("Compromisos"),
		"monitoreo":   trendName == "en aumento",
		"narrativas":  has("Narrativas"),
		"buzon":       has("Buzon"),
		"verificar":   true,
	}
	who := ListNames(actors)
	if who == "" {
		who = "los actores involucrados"
	}
	out := []string{}
	for _, id := range recommendationOrder {
		if when[id] {
			out = append(out, ReplaceAllJS(texts[id], "{actores}", who))
		}
	}
	return out
}

func names(counts []NamedCount) []string {
	out := make([]string, 0, len(counts))
	for _, c := range counts {
		out = append(out, c.Name)
	}
	return out
}

func withoutLabel(counts []NamedCount, skip bool, label string) []NamedCount {
	if !skip {
		return counts
	}
	folded := Fold(label)
	return slices.DeleteFunc(counts, func(c NamedCount) bool { return Fold(c.Name) == folded })
}

func buildSituation(kind, label string, signals []Signal, settings Settings, texts map[string]string) Situation {
	sorted := slices.Clone(signals)
	slices.SortStableFunc(sorted, func(a, b Signal) int {
		if a.AgeDays != b.AgeDays {
			return a.AgeDays - b.AgeDays
		}
		if Less16(a.ID, b.ID) {
			return -1
		}
		if a.ID == b.ID {
			return 0 // JavaScript's comparator answers 1 both ways; its sort keeps them in order
		}
		return 1
	})
	halfLife := toNumber(settings.HalfLifeDays)
	sum := 0.0
	for _, s := range sorted {
		sum += HalfPow(float64(s.AgeDays)/halfLife) * s.Severity
	}
	score := round2(sum)
	tr := trendOf(sorted)
	base := levelFor(score, settings.Thresholds)
	raised := tr.name == "en aumento" && base != "Rojo"
	level := base
	if raised {
		level = Levels[levelIndex(base)+1]
	}
	var actorValues, territoryValues, topicValues []string
	for _, s := range sorted {
		actorValues = append(actorValues, s.Actors...)
		if s.Territory != "" {
			territoryValues = append(territoryValues, s.Territory)
		}
		topicValues = append(topicValues, s.Topics...)
	}
	actors := withoutLabel(counted(actorValues), kind == "actor", label)
	territories := withoutLabel(counted(territoryValues), kind == "territorio", label)
	topics := withoutLabel(counted(topicValues), kind == "tema", label)
	span := max(1, sorted[len(sorted)-1].AgeDays-sorted[0].AgeDays+1)
	recentWord := ""
	if tr.recent > 0 {
		recentWord = "recientes "
	}

	reasons := []Reason{{
		Text: strconv.Itoa(len(sorted)) + " registros relacionados con " + kindLabel[kind] + " «" + label +
			"» en " + strconv.Itoa(span) + " día(s).",
		Records: cite(sorted),
	}}
	if len(actors) > 0 {
		named := make([]string, 0, len(actors))
		for _, a := range actors {
			if a.Count > 1 {
				named = append(named, a.Name+" ("+strconv.Itoa(a.Count)+")")
			} else {
				named = append(named, a.Name)
			}
		}
		reasons = append(reasons, Reason{
			Text:    "Participan " + ListNames(named) + ".",
			Records: cite(filterSignals(sorted, func(s Signal) bool { return len(s.Actors) > 0 })),
		})
	}
	if len(territories) > 0 {
		reasons = append(reasons, Reason{
			Text:    "Territorio registrado: " + ListNames(names(territories)) + ".",
			Records: cite(filterSignals(sorted, func(s Signal) bool { return s.Territory != "" })),
		})
	}
	if kind != "tema" && len(topics) > 0 {
		reasons = append(reasons, Reason{
			Text:    "Temas en común: " + ListNames(names(topics)) + ".",
			Records: cite(filterSignals(sorted, func(s Signal) bool { return len(s.Topics) > 0 })),
		})
	}
	switch tr.name {
	case "en aumento":
		raise := ""
		if raised {
			raise = "; por eso el nivel sube de " + base + " a " + level
		}
		reasons = append(reasons, Reason{
			Text: "En aumento: " + strconv.Itoa(tr.recent) + " registro(s) en los últimos " + strconv.Itoa(recentDays) +
				" días frente a " + JSNumber(tr.weekly) + " por semana en las " + strconv.Itoa(baselineWeeks) +
				" semanas anteriores" + raise + ".",
			Records: cite(filterSignals(sorted, func(s Signal) bool { return s.AgeDays < recentDays })),
		})
	case "en descenso":
		reasons = append(reasons, Reason{
			Text:    "En descenso: sin registros en los últimos " + strconv.Itoa(recentDays) + " días.",
			Records: []string{},
		})
	}
	if severe := filterSignals(sorted, func(s Signal) bool { return s.Severity > 1 }); len(severe) > 0 {
		reasons = append(reasons, Reason{
			Text:    strconv.Itoa(len(severe)) + " registro(s) con prioridad o nivel alto.",
			Records: cite(severe),
		})
	}
	if tone := shiftOfTone(sorted, toNumber(settings.WindowDays)); tone != nil {
		reasons = append(reasons, Reason{
			Text: "Cambio de narrativa: el tono negativo pasa de " + JSNumber(tone.then) + " % a " + JSNumber(tone.now) +
				" % en las publicaciones más recientes.",
			Records: cite(tone.recent),
		})
	}
	reasons = append(reasons, Reason{
		Text: "Puntaje " + JSNumber(score) + ": cada registro pesa la mitad cada " + template(settings.HalfLifeDays) +
			" días y más si su prioridad es alta.",
		Records: []string{},
	})

	who := ""
	if len(actors) > 0 {
		who = " y participación de " + ListNames(names(actors))
	}
	about := kindLabel[kind] + " " + label
	if kind == "tema" {
		about = LowerJS(label)
	}
	rising := ""
	if tr.name == "en aumento" {
		rising = ", en aumento"
	}
	summary := level + " – " + template(settings.LevelMeanings[level]) + ": existen " + strconv.Itoa(len(sorted)) +
		" registros " + recentWord + "relacionados con " + about + who + rising + "."

	records := make([]Citation, 0, len(sorted))
	for _, s := range sorted {
		records = append(records, Citation{Module: s.Module, ID: s.ID, Title: s.Title, Date: s.Date})
	}
	return Situation{
		Key:             kind + ":" + Fold(label),
		Kind:            kind,
		Label:           label,
		Level:           level,
		Score:           score,
		Trend:           tr.name,
		Summary:         summary,
		Reasons:         reasons,
		Recommendations: recommend(level, tr.name, sorted, names(actors), texts),
		Records:         records,
		Actors:          names(actors),
		Territories:     names(territories),
		Topics:          names(topics),
		LastDate:        sorted[0].Date,
		Lessons:         []Lesson{},
	}
}

// narrativeOverview is narrativeOverview(): repeated topics, platforms and tone change.
func narrativeOverview(signals []Signal, platforms map[string]string, windowDays float64) NarrativeOverview {
	narratives := filterSignals(signals, func(s Signal) bool { return s.Module == "Narrativas" })
	isRecent := func(s Signal) bool { return s.AgeDays < recentDays }
	var topicValues, platformValues []string
	for _, s := range narratives {
		topicValues = append(topicValues, s.Topics...)
		if name, ok := platforms[s.ID]; ok {
			platformValues = append(platformValues, name)
		}
	}
	topics := []TopicCount{}
	for _, c := range counted(topicValues) {
		if c.Count < 2 {
			continue
		}
		recent := len(filterSignals(narratives, func(s Signal) bool { return isRecent(s) && slices.Contains(s.Topics, c.Name) }))
		topics = append(topics, TopicCount{Name: c.Name, Count: c.Count, Recent: recent})
		if len(topics) == 10 {
			break
		}
	}
	platformCounts := counted(platformValues)
	out := NarrativeOverview{
		Total:     len(narratives),
		Recent:    len(filterSignals(narratives, isRecent)),
		Topics:    topics,
		Platforms: append([]NamedCount{}, platformCounts[:min(8, len(platformCounts))]...),
	}
	if tone := shiftOfTone(narratives, windowDays); tone != nil {
		out.Tone = &Tone{Now: tone.now, Then: tone.then}
	}
	return out
}

type group struct {
	kind, label string
	signals     []Signal
}

// FindSituations is findSituations() followed by attachLessons(), as the situations service
// calls them: records of the lessons module only inform, they never form situations.
func FindSituations(records []SourceRecord, settings Settings, today string) Report {
	var lessons []SourceRecord
	var signals []Signal
	undated := 0
	windowDays := toNumber(settings.WindowDays)
	for _, record := range records {
		if record.Module == LessonsModule {
			lessons = append(lessons, record)
			continue
		}
		signal, outcome := ToSignal(record, today)
		if outcome == Undated {
			undated++
		}
		if outcome == Dated && float64(signal.AgeDays) <= windowDays {
			signals = append(signals, signal)
		}
	}

	var groups []*group
	index := map[string]*group{}
	add := func(kind, label string, signal Signal) {
		key := kind + ":" + Fold(label)
		g, ok := index[key]
		if !ok {
			g = &group{kind: kind, label: label}
			index[key] = g
			groups = append(groups, g)
		}
		g.signals = append(g.signals, signal)
	}
	for _, s := range signals {
		for _, topic := range s.Topics {
			add("tema", topic, s)
		}
		for _, actor := range s.Actors {
			add("actor", actor, s)
		}
		if s.Territory != "" {
			add("territorio", s.Territory, s)
		}
	}

	texts := texts(settings)
	var built []Situation
	for _, g := range groups {
		if len(g.signals) >= 2 {
			built = append(built, buildSituation(g.kind, g.label, g.signals, settings, texts))
		}
	}
	slices.SortStableFunc(built, func(a, b Situation) int {
		if d := levelIndex(b.Level) - levelIndex(a.Level); d != 0 {
			return d
		}
		if b.Score != a.Score {
			if b.Score > a.Score {
				return 1
			}
			return -1
		}
		if Less16(a.Key, b.Key) {
			return -1
		}
		return 1
	})
	situations := []Situation{}
	seen := map[string]bool{}
	for _, s := range built {
		ids := make([]string, 0, len(s.Records))
		for _, r := range s.Records {
			ids = append(ids, r.Module+":"+r.ID)
		}
		set := strings.Join(ids, "|")
		if seen[set] {
			continue
		}
		seen[set] = true
		situations = append(situations, s)
		if len(situations) == maxSituations {
			break
		}
	}

	platforms := map[string]string{}
	for _, r := range records {
		if r.Module != "Narrativas" {
			continue
		}
		if name := TrimJS(JSString(r.Payload["Plataforma/Fuente"])); name != "" {
			platforms[r.ID] = name
		}
	}
	return Report{
		Situations: attachLessons(situations, lessons),
		Narratives: narrativeOverview(signals, platforms, windowDays),
		Undated:    undated,
		Considered: len(signals),
	}
}

// attachLessons is attachLessons(): lessons that share a situation's key, newest first. They
// never weigh in the score or the colour, and one without what was learned is not shown.
func attachLessons(situations []Situation, records []SourceRecord) []Situation {
	type keyed struct {
		lesson Lesson
		keys   []string
	}
	var all []keyed
	for _, r := range records {
		learned := First(r.Payload, []string{"Aprendido"})
		if learned == "" {
			continue
		}
		k := keyed{lesson: Lesson{ID: r.ID, Date: First(r.Payload, []string{"Fecha"}), Learned: learned}}
		for _, pair := range [][2]string{
			{"territorio", First(r.Payload, TerritoryFields)},
			{"tema", First(r.Payload, []string{"Tema"})},
			{"actor", First(r.Payload, []string{"Actor"})},
		} {
			if pair[1] != "" {
				k.keys = append(k.keys, pair[0]+":"+Fold(pair[1]))
			}
		}
		all = append(all, k)
	}
	for i := range situations {
		lessons := []Lesson{}
		for _, k := range all {
			if slices.Contains(k.keys, situations[i].Key) {
				lessons = append(lessons, k.lesson)
			}
		}
		slices.SortStableFunc(lessons, func(a, b Lesson) int {
			switch {
			case Less16(a.Date, b.Date):
				return 1
			case Less16(b.Date, a.Date):
				return -1
			}
			return 0
		})
		situations[i].Lessons = lessons
	}
	return situations
}

// decodeJSON keeps numbers as json.Number, as the domain reads them.
func decodeJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	err := dec.Decode(&v)
	return v, err
}

// DecodeObject decodes a stored jsonb object; anything else reads as an empty object.
func DecodeObject(raw []byte) (map[string]any, error) {
	v, err := decodeJSON(raw)
	if err != nil {
		return nil, err
	}
	m, _ := v.(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}
