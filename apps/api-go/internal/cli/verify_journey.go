package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

const verifyModule = "compromisos"

func (v *verifier) anonymous() error {
	v.want("health answers", http.StatusOK, call{method: http.MethodGet, path: "/health"})
	me := v.want("no session means no identity", http.StatusOK, call{method: http.MethodGet, path: "/system/auth/me"})
	v.that("the identity is null", me.data == nil, "an anonymous request got an identity")
	v.want("data asks for a session", http.StatusUnauthorized, call{method: http.MethodGet, path: "/api/" + verifyModule})
	return nil
}

// login signs an actor in, keeping the code it used. A code works once and the API takes this step
// and the next: right after enrolment this step is spent, so firstOffset starts at the next one.
// A wrong try counts towards the API's limit of failures per address, so none is wasted. It sends
// no project of its own: a first sign-in has no scope.
func (v *verifier) login(who *actor, firstOffset int64) error {
	c, err := newClient(v.base, v.options.caFile, v.options.timeout, nil, "")
	if err != nil {
		return err
	}
	who.client = c
	for _, offset := range []int64{firstOffset, 1 - firstOffset} {
		who.code = ""
		if who.secret != "" {
			if who.code, err = totpCode(who.secret, v.app.step()+offset); err != nil {
				return err
			}
		}
		answer := v.send(call{
			as: who, method: http.MethodPost, path: "/login", contentType: "application/x-www-form-urlencoded",
			form: loginForm(who.username, who.password, who.code),
		})
		if answer.status == http.StatusOK {
			return nil
		}
		if apiDetail(answer) != badOTP {
			return fmt.Errorf("%s could not sign in: %d %s", who.label, answer.status, shortDetail(answer))
		}
	}
	return fmt.Errorf("%s: the API refused this code and the next", who.label)
}

func (v *verifier) signIn() error {
	me, err := v.must("the saved session is alive", call{as: v.admin, method: http.MethodGet, path: "/system/auth/me"})
	if err != nil {
		return err
	}
	if !v.that("the session is an administrator's", text(me, "role") == "admin", "verify needs an administrator: "+text(me, "role")) {
		return errStop
	}
	v.admin.username = text(me, "username")
	v.want("a foreign Origin is refused on a write", http.StatusForbidden, call{
		as: v.admin, method: http.MethodPost, path: "/api/" + verifyModule, origin: "https://synthetic.invalid",
		json: map[string]any{"payload": map[string]any{"Texto": "must not exist"}},
	})
	return nil
}

func (v *verifier) projects() error {
	v.projectA, v.projectB = "VERIFY/A-"+v.run, "VERIFY/B-"+v.run
	for _, tenant := range []string{v.projectA, v.projectB} {
		company, project := companyAndProject(tenant)
		if _, err := v.must("the administrator creates "+tenant, call{
			as: v.admin, method: http.MethodPost, path: "/system/auth/scopes",
			json: map[string]any{"company_id": company, "project_id": project, "label": "Verify " + project, "username": v.admin.username},
		}); err != nil {
			return err
		}
	}
	list := v.want("the administrator lists projects", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/auth/scopes"})
	v.that("both projects are listed", holds(list, "A-"+v.run) && holds(list, "B-"+v.run), "a new project is missing")
	v.admin.client.project = v.projectA
	current := v.want("the header selects the project", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/auth/current-scope"})
	v.that("the active project is the chosen one", text(current, "scope") == v.projectA, text(current, "scope"))
	return nil
}

func (v *verifier) createAccount(label, role, tenant string) (*actor, error) {
	who := &actor{label: label, username: "verify-" + v.run + "-" + label, password: "synthetic-" + randomHex(12)}
	if _, err := v.must("the administrator creates the "+label, call{
		as: v.admin, project: tenant, method: http.MethodPost, path: "/system/auth/accounts",
		json: map[string]any{"username": who.username, "full_name": "Verify " + label, "password": who.password, "role": role},
	}); err != nil {
		return nil, err
	}
	v.created = append(v.created, who.username)
	company, project := companyAndProject(tenant)
	if _, err := v.must("the "+label+" gets the project", call{
		as: v.admin, method: http.MethodPost, path: "/system/auth/grants",
		json: map[string]any{"username": who.username, "company_id": company, "project_id": project},
	}); err != nil {
		return nil, err
	}
	return who, nil
}

func (v *verifier) accounts() error {
	var err error
	if v.analyst, err = v.createAccount("analyst", "analista", v.projectA); err != nil {
		return err
	}
	if v.viewer, err = v.createAccount("viewer", "consulta", v.projectA); err != nil {
		return err
	}
	if v.outsider, err = v.createAccount("outsider", "analista", v.projectB); err != nil {
		return err
	}
	v.want("a wrong password is refused", http.StatusUnauthorized, call{
		method: http.MethodPost, path: "/login", contentType: "application/x-www-form-urlencoded",
		form: loginForm(v.analyst.username, "synthetic-wrong-password", ""),
	})
	list := v.want("the account list shows them", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/auth/accounts"})
	v.that("the list holds the new account", holds(list, v.viewer.username), "missing account")
	v.that("the list holds no password", !holds(list, v.viewer.password), "a password was listed")
	v.want("a short password is refused", http.StatusUnprocessableEntity, call{
		as: v.admin, method: http.MethodPost, path: "/system/auth/accounts",
		json: map[string]any{"username": "verify-" + v.run + "-short", "full_name": "x", "password": "short", "role": "consulta"},
	})
	return nil
}

// enrol takes a new account through MFA as a person would.
func (v *verifier) enrol(who *actor) error {
	if who.client == nil {
		if err := v.login(who, 0); err != nil {
			return err
		}
	}
	setup := v.send(call{as: who, method: http.MethodPost, path: "/system/auth/totp/setup"})
	secret := text(setup, "secret")
	if setup.status != http.StatusOK || secret == "" {
		return fmt.Errorf("%s: TOTP setup answered %d", who.label, setup.status)
	}
	code, err := totpCode(secret, v.app.step())
	if err != nil {
		return err
	}
	enabled := v.send(call{as: who, method: http.MethodPost, path: "/system/auth/totp/enable", json: map[string]string{"code": code}})
	if enabled.status != http.StatusOK {
		return fmt.Errorf("%s: TOTP enable answered %d", who.label, enabled.status)
	}
	who.secret = secret
	return nil
}

func (v *verifier) mfa() error {
	who := v.viewer
	if err := v.login(who, 0); err != nil {
		v.that("a new account signs in", false, err.Error())
		return errStop
	}
	v.want("no data before MFA", http.StatusForbidden, call{as: who, method: http.MethodGet, path: "/api/" + verifyModule})
	if err := v.enrol(who); err != nil {
		v.that("the account enrols MFA", false, err.Error())
		return errStop
	}
	v.that("the account enrols MFA", true, "")
	v.want("signing in now needs the code", http.StatusUnauthorized, call{
		method: http.MethodPost, path: "/login", contentType: "application/x-www-form-urlencoded",
		form: loginForm(who.username, who.password, ""),
	})
	if err := v.login(who, 1); err != nil {
		v.that("the code signs in", false, err.Error())
		return errStop
	}
	v.that("the code signs in", true, "")
	replay := v.send(call{
		method: http.MethodPost, path: "/login", contentType: "application/x-www-form-urlencoded",
		form: loginForm(who.username, who.password, who.code),
	})
	v.that("a used code is refused", replay.status == http.StatusUnauthorized, fmt.Sprint(replay.status))
	for _, next := range []*actor{v.analyst, v.outsider} {
		if err := v.enrol(next); err != nil {
			v.that(next.label+" enrols MFA", false, err.Error())
			return errStop
		}
		if err := v.login(next, 1); err != nil {
			v.that(next.label+" signs in with the code", false, err.Error())
			return errStop
		}
	}
	return nil
}

func (v *verifier) records() error {
	path := "/api/" + verifyModule
	v.marker = "VERIFY-" + v.run
	created, err := v.must("an analyst creates a record", call{
		as: v.analyst, method: http.MethodPost, path: path,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": v.marker, "Texto": "synthetic " + v.marker, "Estado": "Abierto"}},
	})
	if err != nil {
		return err
	}
	v.record = text(created, "id")
	v.that("the record keeps its id", v.record == v.marker, v.record)
	read := v.want("the record reads back", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: path + "/" + v.marker})
	v.that("the stored text is the sent text", text(read, "Texto") == "synthetic "+v.marker, text(read, "Texto"))
	v.that("the record belongs to the project", holds(read, "A-"+v.run), "no project on the record")
	v.want("the record is updated", http.StatusOK, call{
		as: v.analyst, method: http.MethodPut, path: path + "/" + v.marker,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": v.marker, "Texto": "changed " + v.marker, "Estado": "Abierto"}},
	})
	read = v.want("the change is stored", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: path + "/" + v.marker})
	v.that("another account of the project reads the change", text(read, "Texto") == "changed "+v.marker, text(read, "Texto"))
	history := v.want("the history answers", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: path + "/" + v.marker + "/history"})
	v.that("the history has both versions", len(items(history)) == 2, fmt.Sprintf("%d versions", len(items(history))))
	v.that("the history names the author", holds(history, v.analyst.username), "no author")
	decoy := "VERIFY-DECOY-" + v.run
	v.want("an unrelated record is created", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: path,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": decoy, "Texto": "unrelated"}},
	})
	found := v.want("search finds it", http.StatusOK, call{
		as: v.analyst, method: http.MethodGet, path: path, query: url.Values{"q": {v.marker}},
	})
	all := v.want("the whole list answers", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: path})
	v.that("the list holds both records", len(items(all)) >= 2, fmt.Sprintf("%d rows", len(items(all))))
	v.that("search keeps only this record", len(items(found)) == 1 && holds(found, v.marker) && !holds(found, decoy), fmt.Sprintf("%d rows", len(items(found))))
	v.want("an unknown module is refused", http.StatusNotFound, call{as: v.analyst, method: http.MethodGet, path: "/api/no-such-module"})
	v.want("an unknown record is 404", http.StatusNotFound, call{as: v.analyst, method: http.MethodGet, path: path + "/VERIFY-NONE"})
	other := "VERIFY-DELETE-" + v.run
	v.want("a second record is created", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: path,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": other, "Texto": "to delete"}},
	})
	v.want("it is deleted", http.StatusOK, call{as: v.analyst, method: http.MethodDelete, path: path + "/" + other})
	v.want("it is gone", http.StatusNotFound, call{as: v.analyst, method: http.MethodGet, path: path + "/" + other})
	v.want("importing checks before writing", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: "/system/import/" + verifyModule,
		json: map[string]any{"rows": []map[string]string{{"ID_Compromiso": "VERIFY-DRY-" + v.run, "Texto": "dry"}}},
	})
	v.want("a dry run stored nothing", http.StatusNotFound, call{
		as: v.analyst, method: http.MethodGet, path: path + "/VERIFY-DRY-" + v.run,
	})
	v.want("an event is created", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: "/api/eventos",
		json: map[string]any{"payload": map[string]any{"ID_Evento": "VERIFY-EV-" + v.run, "Descripcion": "synthetic event", "Fecha": "2026-01-15"}},
	})
	summary := v.want("the register summary answers", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: "/api/registros/summary"})
	v.that("the summary counts the event", object(summary, "counts")["eventos"] == float64(1), fmt.Sprint(object(summary, "counts")["eventos"]))
	v.that("the summary lists the event", holds(summary, "VERIFY-EV-"+v.run), "the event is not in the rows")
	return nil
}

func (v *verifier) prevention() error {
	alert, err := v.must("an analyst registers an alert", call{
		as: v.analyst, method: http.MethodPost, path: "/system/intelligence/territorial-alerts",
		json: map[string]any{"text": "Synthetic signal " + v.marker + ": bloqueo de vía anunciado por la comunidad.", "source_type": "Reporte de campo"},
	})
	if err != nil {
		return err
	}
	v.alert = text(alert, "id")
	base := "/system/prevention/actions"
	body := map[string]any{
		"alert_id": v.alert, "title": "Synthetic action " + v.marker, "responsible": "Verify analyst", "due_date": "2099-12-01",
	}
	v.want("an action needs a corroborated alert", http.StatusConflict, call{as: v.analyst, method: http.MethodPost, path: base, json: body})
	if _, err := v.must("the alert is corroborated", call{
		as: v.analyst, method: http.MethodPatch, path: "/system/intelligence/territorial-alerts/" + v.alert,
		json: map[string]any{"status": "Corroborado", "note": "synthetic verification note"},
	}); err != nil {
		return err
	}
	created, err := v.must("an action is created", call{as: v.analyst, method: http.MethodPost, path: base, json: body})
	if err != nil {
		return err
	}
	v.action = fmt.Sprint(object(created, "action")["id"])
	v.that("the action starts pending", object(created, "action")["status"] == "Pendiente", fmt.Sprint(object(created, "action")["status"]))
	moved := v.want("the action moves on", http.StatusOK, call{
		as: v.analyst, method: http.MethodPatch, path: base + "/" + v.action,
		json: map[string]any{"status": "En ejecución", "progress": 40, "note": "synthetic progress"},
	})
	v.that("the progress is stored", object(moved, "action")["progress"] == float64(40), fmt.Sprint(object(moved, "action")["progress"]))
	v.want("closing needs evidence", http.StatusUnprocessableEntity, call{
		as: v.analyst, method: http.MethodPatch, path: base + "/" + v.action,
		json: map[string]any{"status": "Completada", "progress": 100, "note": "synthetic close"},
	})
	summary := v.want("the summary answers", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: "/system/prevention/summary"})
	v.that("the summary counts the active action", number(summary, "active") == 1, fmt.Sprint(number(summary, "active")))
	v.want("the situation room answers", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/prevention/situation-room"})
	return nil
}

func (v *verifier) evidence() error {
	if v.record == "" {
		v.that("evidence needs the record", false, "the records part did not create one")
		return errStop
	}
	v.uploadBytes = []byte("synthetic evidence " + v.marker + "\n")
	fields := keyValues{"linked_module": {verifyModule}, "linked_record_id": {v.record}, "document_type": {"Acta"}}
	send := func(as *actor, f keyValues, file attachment) *response {
		body, contentType, err := multipartBody(f, []attachment{file})
		if err != nil {
			return &response{}
		}
		return v.send(call{as: as, method: http.MethodPost, path: "/system/uploads", form: body, contentType: contentType})
	}
	stored := send(v.analyst, fields, attachment{"file", "verify-evidence.txt", v.uploadBytes})
	if !v.that("evidence is uploaded", stored.status == http.StatusOK, fmt.Sprintf("%d %s", stored.status, shortDetail(stored))) {
		return errStop
	}
	v.upload = fmt.Sprint(object(stored, "attachment")["id"])
	hash := sha256.Sum256(v.uploadBytes)
	meta := v.want("its record answers", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/uploads/" + v.upload})
	v.that("the stored hash is the file's", text(meta, "sha256") == hex.EncodeToString(hash[:]), text(meta, "sha256"))
	file := v.want("it downloads", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/uploads/" + v.upload + "/download"})
	v.that("the bytes are the same", file.file != nil && file.file.SHA256 == hex.EncodeToString(hash[:]), "hash differs")
	preview := v.want("it previews", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/uploads/" + v.upload + "/preview"})
	v.that("the preview holds the text", holds(preview, v.marker), "marker missing")
	listed := v.want("the record lists it", http.StatusOK, call{
		as: v.viewer, method: http.MethodGet, path: "/system/uploads",
		query: url.Values{"linked_module": {verifyModule}, "linked_record_id": {v.record}},
	})
	v.that("exactly one file is linked", len(items(listed)) == 1, fmt.Sprint(len(items(listed))))
	decoyLink := keyValues{"linked_module": {verifyModule}, "linked_record_id": {"VERIFY-DECOY-" + v.run}}
	second := send(v.analyst, decoyLink, attachment{"file", "verify-other.txt", []byte("synthetic other\n")})
	v.that("a second file links to another record", second.status == http.StatusOK, fmt.Sprint(second.status))
	again := v.send(call{
		as: v.viewer, method: http.MethodGet, path: "/system/uploads",
		query: url.Values{"linked_module": {verifyModule}, "linked_record_id": {v.record}},
	})
	v.that("the link filter still gives one file", len(items(again)) == 1, fmt.Sprint(len(items(again))))
	wrong := send(v.analyst, fields, attachment{"file", "verify.exe", []byte("MZ synthetic")})
	v.that("an unsupported type is refused", wrong.status == http.StatusUnsupportedMediaType || wrong.status == http.StatusBadRequest, fmt.Sprint(wrong.status))
	unknown := keyValues{"linked_module": {verifyModule}, "linked_record_id": {"VERIFY-NONE"}}
	missing := send(v.analyst, unknown, attachment{"file", "verify.txt", v.uploadBytes})
	v.that("an unknown record is refused", missing.status == http.StatusNotFound, fmt.Sprint(missing.status))
	if v.action != "" {
		closed := v.want("the action closes with the evidence", http.StatusOK, call{
			as: v.analyst, method: http.MethodPatch, path: "/system/prevention/actions/" + v.action,
			json: map[string]any{"status": "Completada", "progress": 100, "note": "synthetic close", "evidence_attachment_id": v.upload},
		})
		v.that("the action is complete", object(closed, "action")["status"] == "Completada", shortDetail(closed))
		summary := v.want("the summary follows", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: "/system/prevention/summary"})
		v.that("the action counts as completed", number(summary, "completed") == 1, fmt.Sprint(number(summary, "completed")))
	}
	return nil
}

func (v *verifier) reports() error {
	for name, path := range map[string]string{
		"situational": "/system/situational-report.docx",
		"strategic":   "/system/strategic-report.docx",
		"integrated":  "/system/integrated-analysis.docx",
		"consensus":   "/system/consensus-engine.docx",
	} {
		answer := v.want("the "+name+" report downloads", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: path})
		v.that("the "+name+" report has content", answer.file != nil && answer.file.Bytes > 1000, "too small")
	}
	csv := v.want("the management report downloads", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/management/report.csv"})
	v.that("the management report has content", csv.file != nil && csv.file.Bytes > 0, "empty")
	v.want("only an administrator exports", http.StatusForbidden, call{as: v.analyst, method: http.MethodGet, path: "/system/export"})
	export := v.want("the administrator exports the project", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/export"})
	v.that("the export holds the record", holds(export, v.marker), "the marker is not in the export")
	return nil
}

func (v *verifier) documentLab() error {
	text1 := []byte("Compromiso: la empresa entregará agua potable a la comunidad antes de diciembre. " + v.marker + "\n")
	text2 := []byte("Compromiso: la empresa construirá un puesto de salud para la comunidad. " + v.marker + "\n")
	form := func(files ...attachment) ([]byte, string) {
		body, contentType, err := multipartBody(nil, files)
		if err != nil {
			panic(err) // a form built in memory cannot fail
		}
		return body, contentType
	}
	body, contentType := form(attachment{"file", "verify.txt", text1})
	analysis := v.want("a document is analysed", http.StatusOK, call{
		as: v.viewer, method: http.MethodPost, path: "/system/document-lab/analyze", form: body, contentType: contentType,
	})
	v.that("the analysis names the file", text(analysis, "filename") == "verify.txt", text(analysis, "filename"))
	body, contentType = form(attachment{"file_a", "a.txt", text1}, attachment{"file_b", "b.txt", text2})
	v.want("two documents are compared", http.StatusOK, call{
		as: v.viewer, method: http.MethodPost, path: "/system/document-lab/compare", form: body, contentType: contentType,
	})
	body, contentType = form(attachment{"file", "verify.txt", text1})
	report := v.want("the analysis report downloads", http.StatusOK, call{
		as: v.viewer, method: http.MethodPost, path: "/system/document-lab/report.docx", form: body, contentType: contentType,
	})
	v.that("the report has content", report.file != nil && report.file.Bytes > 1000, "too small")
	hash := sha256.Sum256(text1)
	queued := v.want("items join the review queue", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: "/system/document-lab/review/import",
		json: map[string]any{"filename": "verify.txt", "sha256": hex.EncodeToString(hash[:]), "items": []map[string]string{{
			"tema": "agua", "fragmento": "entregará agua potable " + v.marker, "ubicacion": "p1", "accion_sugerida": "Registrar compromiso",
		}}},
	})
	v.that("one item is new", number(queued, "new_items") == 1, shortDetail(queued))
	queue := v.want("the queue answers", http.StatusOK, call{
		as: v.viewer, method: http.MethodGet, path: "/system/document-lab/review", query: url.Values{"limit": {"50"}},
	})
	list, _ := queue.data.(map[string]any)
	entries, _ := list["items"].([]any)
	if !v.that("the queue holds the item", len(entries) == 1, fmt.Sprint(len(entries))) {
		return errStop
	}
	entry, _ := entries[0].(map[string]any)
	decided := v.want("the item is decided", http.StatusOK, call{
		as: v.analyst, method: http.MethodPatch, path: "/system/document-lab/review/" + fmt.Sprint(entry["id"]),
		json: map[string]any{"status": "descartado", "note": "synthetic decision"},
	})
	v.that("the decision is stored", text(decided, "status") == "descartado", shortDetail(decided))
	return nil
}

func (v *verifier) management() error {
	overview := v.want("the overview answers", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/management/overview"})
	v.that("the overview is of this project", text(overview, "project_id") == "A-"+v.run, text(overview, "project_id"))
	dashboard := v.want("the dashboard answers", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/api/dashboard"})
	v.that("the dashboard counts the event", number(dashboard, "eventos") == 1, fmt.Sprint(number(dashboard, "eventos")))
	return nil
}

func (v *verifier) automation() error {
	rule, err := v.must("the administrator creates a rule", call{
		as: v.admin, method: http.MethodPost, path: "/system/automations/rules",
		json: map[string]any{
			"name": "Verify " + v.run, "module": "Compromisos", "actions": []string{"CREATE"},
			"steps": []map[string]any{{"kind": "notify", "title": "Verify " + v.marker}},
		},
	})
	if err != nil {
		return err
	}
	id := text(rule, "id")
	if id == "" {
		id = fmt.Sprint(number(rule, "id"))
	}
	v.want("an analyst may not create rules", http.StatusForbidden, call{
		as: v.analyst, method: http.MethodPost, path: "/system/automations/rules", json: map[string]any{},
	})
	listed := v.want("the rule is listed", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/automations"})
	v.that("the list holds the rule", holds(listed, "Verify "+v.run), "rule missing")
	v.want("a record wakes the rule", http.StatusOK, call{
		as: v.analyst, method: http.MethodPost, path: "/api/" + verifyModule,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": "VERIFY-RULE-" + v.run, "Texto": "synthetic trigger"}},
	})
	v.want("a tick runs on demand", http.StatusOK, call{as: v.admin, method: http.MethodPost, path: "/system/automations/tick"})
	notified := false
	for range 20 {
		answer := v.send(call{as: v.admin, method: http.MethodGet, path: "/system/notifications"})
		if notified = holds(answer, v.marker); notified {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	v.that("the rule notified", notified, "no notification with the marker")
	v.want("the rule is deleted", http.StatusOK, call{as: v.admin, method: http.MethodDelete, path: "/system/automations/rules/" + id})
	runtime := v.want("the runtime answers", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/automations/runtime"})
	body, _ := runtime.data.(map[string]any)
	v.that("the runtime reports event processing on", body["event_processing"] == true, shortDetail(runtime))
	return nil
}

func (v *verifier) notifications() error {
	first := v.want("the list answers", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/notifications"})
	v.that("something is unread", number(first, "unread") > 0, fmt.Sprint(number(first, "unread")))
	v.want("everything is marked read", http.StatusOK, call{
		as: v.admin, method: http.MethodPost, path: "/system/notifications/read", json: map[string]any{"all": true},
	})
	after := v.want("the list follows", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/notifications"})
	v.that("nothing is unread", number(after, "unread") == 0, fmt.Sprint(number(after, "unread")))
	v.want("push state answers", http.StatusOK, call{as: v.viewer, method: http.MethodGet, path: "/system/notifications/push/state"})
	return nil
}

// isolation proves a second tenant sees nothing: what project A wrote does not exist from B.
func (v *verifier) isolation() error {
	who := v.outsider
	path := "/api/" + verifyModule
	list := v.want("the other project's list answers", http.StatusOK, call{as: who, method: http.MethodGet, path: path})
	v.that("the other project sees no records", len(items(list)) == 0, fmt.Sprintf("%d rows", len(items(list))))
	v.want("a record of project A is 404 from B", http.StatusNotFound, call{as: who, method: http.MethodGet, path: path + "/" + v.marker})
	v.want("its history is 404 from B", http.StatusNotFound, call{as: who, method: http.MethodGet, path: path + "/" + v.marker + "/history"})
	v.want("it cannot be updated from B", http.StatusNotFound, call{
		as: who, method: http.MethodPut, path: path + "/" + v.marker, json: map[string]any{"payload": map[string]any{"Texto": "stolen"}},
	})
	v.want("it cannot be deleted from B", http.StatusNotFound, call{as: who, method: http.MethodDelete, path: path + "/" + v.marker})
	still := v.want("the record is intact in A", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: path + "/" + v.marker})
	v.that("the text did not change", text(still, "Texto") == "changed "+v.marker, text(still, "Texto"))
	v.want("naming project A in the header is refused", http.StatusForbidden, call{as: who, project: v.projectA, method: http.MethodGet, path: path})
	_, projectA := companyAndProject(v.projectA)
	v.want("naming project A in the query is refused", http.StatusForbidden, call{
		as: who, method: http.MethodGet, path: path, query: url.Values{"project_id": {projectA}},
	})
	v.want("writing into project A is refused", http.StatusForbidden, call{
		as: who, method: http.MethodPost, path: path, json: map[string]any{"project_id": projectA, "payload": map[string]any{"Texto": "x"}},
	})
	if v.upload != "" {
		v.want("A's file is 404 from B", http.StatusNotFound, call{as: who, method: http.MethodGet, path: "/system/uploads/" + v.upload})
		v.want("A's bytes are 404 from B", http.StatusNotFound, call{as: who, method: http.MethodGet, path: "/system/uploads/" + v.upload + "/download"})
	}
	if v.action != "" {
		v.want("A's action cannot be changed from B", http.StatusNotFound, call{
			as: who, method: http.MethodPatch, path: "/system/prevention/actions/" + v.action,
			json: map[string]any{"status": "Cancelada", "progress": 0, "note": "stolen"},
		})
	}
	query := url.Values{"q": {v.marker}}
	own := v.want("search finds the record in project A", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: "/system/search", query: query})
	v.that("project A has a hit", len(hits(own)) > 0, "the search control found nothing, so the next check would prove nothing")
	foreign := v.want("search answers in project B", http.StatusOK, call{as: who, method: http.MethodGet, path: "/system/search", query: query})
	v.that("project B has no hit", len(hits(foreign)) == 0, fmt.Sprintf("%d hits", len(hits(foreign))))
	v.isolatedReads()
	return nil
}

// A webhook's scan runs in the background: how long verify waits for its notification. Short of
// the local install's default schedule of 60 s, so a scheduled tick rarely hides a missing wakeup.
const (
	webhookWakeTries = 20
	webhookWakeEvery = 250 * time.Millisecond
)

// machine proves the machine routes work with their own credential, and only with it: a key
// reaches /mcp and writes into its own project, and a revoked key stops at once.
func (v *verifier) machine() error {
	created, err := v.must("the administrator issues a key", call{
		as: v.admin, method: http.MethodPost, path: "/system/integrations/api-keys",
		json: map[string]any{"name": "Verify " + v.run, "access": "write", "clearance": "limited"},
	})
	if err != nil {
		return err
	}
	token, id := text(created, "token"), fmt.Sprint(number(created, "id"))
	if !v.that("the answer holds the key and its id", token != "" && number(created, "id") > 0, shortDetail(created)) {
		return errStop
	}
	listed := v.want("the key is listed", http.StatusOK, call{as: v.admin, method: http.MethodGet, path: "/system/integrations/api-keys"})
	v.that("the list holds the key but not its value", holds(listed, id) && !holds(listed, token), "wrong list")
	initialize := map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "sipgesctl", "version": "1"}},
	}
	v.want("the key reaches /mcp", http.StatusOK, call{bearer: token, method: http.MethodPost, path: "/mcp", json: initialize})
	v.want("the session does not", http.StatusUnauthorized, call{as: v.admin, method: http.MethodPost, path: "/mcp", json: initialize})
	hook := "VERIFY-HOOK-" + v.run
	ingest := v.send(call{
		bearer: token, method: http.MethodPost, path: "/hooks/ingest/" + verifyModule,
		json: map[string]any{"ID_Compromiso": hook, "Texto": "synthetic webhook"},
	})
	v.that("a webhook is accepted", ingest.status < 300, fmt.Sprintf("%d %s", ingest.status, shortDetail(ingest)))
	v.want("the webhook's record is in the key's project", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: "/api/" + verifyModule + "/" + hook})
	v.want("and not in the other project", http.StatusNotFound, call{as: v.outsider, method: http.MethodGet, path: "/api/" + verifyModule + "/" + hook})
	if err := v.webhookWakes(token); err != nil {
		return err
	}
	v.want("the key is revoked", http.StatusOK, call{as: v.admin, method: http.MethodDelete, path: "/system/integrations/api-keys/" + id})
	v.want("a revoked key stops", http.StatusUnauthorized, call{bearer: token, method: http.MethodPost, path: "/mcp", json: initialize})
	return nil
}

// webhookWakes proves a webhook starts the scan itself. Everything after it is a read, because
// any session write would wake the project and process the webhook on the webhook's behalf.
func (v *verifier) webhookWakes(token string) error {
	title := "Verify webhook " + v.run
	before := v.settledAttempt("")
	rule, err := v.must("the administrator creates a webhook rule", call{
		as: v.admin, method: http.MethodPost, path: "/system/automations/rules",
		json: map[string]any{
			"name": title, "module": "Compromisos", "actions": []string{"CREATE"},
			"steps": []map[string]any{{"kind": "notify", "title": title}},
		},
	})
	if err != nil {
		return err
	}
	// Creating the rule is a write, and the scan it starts would pick the webhook up.
	v.settledAttempt(before)
	ingest := v.send(call{
		bearer: token, method: http.MethodPost, path: "/hooks/ingest/" + verifyModule,
		json: map[string]any{"ID_Compromiso": "VERIFY-WAKE-" + v.run, "Texto": "synthetic webhook trigger"},
	})
	v.that("a webhook for the rule is accepted", ingest.status == http.StatusCreated, fmt.Sprintf("%d %s", ingest.status, shortDetail(ingest)))
	notified := false
	for range webhookWakeTries {
		answer := v.send(call{as: v.admin, method: http.MethodGet, path: "/system/notifications"})
		if notified = holds(answer, title); notified {
			break
		}
		time.Sleep(webhookWakeEvery)
	}
	v.that("the webhook alone wakes the rule", notified, "no notification, and no session write followed the webhook")
	id := text(rule, "id")
	if id == "" {
		id = fmt.Sprint(number(rule, "id"))
	}
	v.want("the webhook rule is deleted", http.StatusOK, call{as: v.admin, method: http.MethodDelete, path: "/system/automations/rules/" + id})
	return nil
}

// settledAttempt waits for the project's latest scan to end and differ from after, and returns
// when it started. With after empty, any ended scan will do, or none at all.
func (v *verifier) settledAttempt(after string) string {
	started := ""
	for range webhookWakeTries {
		answer := v.send(call{as: v.admin, method: http.MethodGet, path: "/system/automations/runtime"})
		attempt := object(answer, "latest_attempt")
		started = fmt.Sprint(attempt["started_at"])
		if attempt["status"] != "running" && started != after {
			return started
		}
		time.Sleep(webhookWakeEvery)
	}
	return started
}

// isolatedRead is one read seen from both sides. A read that shows nothing from project B proves
// nothing unless the same read shows the data from project A, so every entry has both.
type isolatedRead struct {
	path         string
	owner, other *actor
	otherProject string
	seen         func(*response) bool
}

func (v *verifier) isolatedReads() {
	marked := func(r *response) bool { return holds(r, v.marker) }
	counted := func(r *response) bool { return number(r, "eventos") > 0 }
	summed := func(r *response) bool {
		return object(r, "counts")["eventos"] != float64(0) || holds(r, "VERIFY-EV-"+v.run)
	}
	listed := func(r *response) bool { return len(items(r)) > 0 }
	dated := func(r *response) bool {
		body, _ := r.data.(map[string]any)
		entries, _ := body["entries"].([]any)
		return len(entries) > 0
	}
	who := v.outsider
	for _, read := range []isolatedRead{
		{path: "/system/uploads", owner: v.analyst, other: who, seen: listed},
		{path: "/system/prevention/actions", owner: v.analyst, other: who, seen: listed},
		{path: "/system/intelligence/territorial-alerts", owner: v.analyst, other: who, seen: marked},
		{path: "/api/registros/summary", owner: v.analyst, other: who, seen: summed},
		{path: "/api/dashboard", owner: v.analyst, other: who, seen: counted},
		{path: "/system/timeline", owner: v.analyst, other: who, seen: dated},
		{path: "/system/document-lab/review", owner: v.analyst, other: who, seen: marked},
		{path: "/system/notifications", owner: v.admin, other: v.admin, otherProject: v.projectB, seen: marked},
		{path: "/system/audit", owner: v.admin, other: v.admin, otherProject: v.projectB, seen: marked},
		{path: "/system/export", owner: v.admin, other: v.admin, otherProject: v.projectB, seen: marked},
	} {
		own := v.send(call{as: read.owner, method: http.MethodGet, path: read.path})
		foreign := v.send(call{as: read.other, project: read.otherProject, method: http.MethodGet, path: read.path})
		v.that(read.path+" shows the data in project A", own.status == http.StatusOK && read.seen(own), fmt.Sprintf("status %d", own.status))
		v.that(read.path+" shows nothing of it in project B", foreign.status == http.StatusOK && !read.seen(foreign), fmt.Sprintf("status %d", foreign.status))
	}
	own := v.send(call{as: v.viewer, method: http.MethodGet, path: "/system/management/overview"})
	foreign := v.send(call{as: who, method: http.MethodGet, path: "/system/management/overview"})
	v.that("the overview stays in its project", text(own, "project_id") == "A-"+v.run && text(foreign, "project_id") == "B-"+v.run && !holds(foreign, v.marker), text(foreign, "project_id"))
}

// viewerWrites are the routes a read-only role may still post to: analysis that stores nothing
// and its own MFA and notifications (internal/identity/domain/access.go).
var viewerWrites = []string{
	"/system/analyze", "/system/document-lab/analyze", "/system/document-lab/compare",
	"/system/document-lab/report.docx", "/system/intelligence/semantic-analyze", "/system/geography/query",
	"/system/graph/neighbourhood", "/system/auth/totp/setup", "/system/auth/totp/enable",
	"/system/notifications/read", "/system/notifications/push", "/system/notifications/push/unsubscribe",
	"/system/notifications/push/test",
}

// placeholderPath fills a route's {names} with values that exist, so a refusal comes from the
// rule under test and not from a missing record.
func (v *verifier) placeholderPath(route Route) string {
	return strings.NewReplacer("{module}", verifyModule, "{id}", v.marker, "{username}", "verify-"+v.run+"-nobody").Replace(route.Path)
}

// readOnly proves the read-only role is refused on every route that writes, and that nothing
// changed.
func (v *verifier) readOnly() error {
	who := v.viewer
	path := "/api/" + verifyModule
	v.want("a read-only role reads", http.StatusOK, call{as: who, method: http.MethodGet, path: path})
	before := v.send(call{as: who, method: http.MethodGet, path: path + "/" + v.marker})
	refused, problems := 0, []string{}
	for _, route := range v.app.routes {
		if route.Method == http.MethodGet || route.Access != AccessSession || slices.Contains(viewerWrites, route.Path) {
			continue
		}
		answer := v.send(call{as: who, method: route.Method, path: v.placeholderPath(route), json: map[string]any{}})
		if answer.status == http.StatusForbidden {
			refused++
			continue
		}
		problems = append(problems, fmt.Sprintf("%s answered %d", route.Key(), answer.status))
	}
	v.that(fmt.Sprintf("every write route refuses it (%d routes)", refused), len(problems) == 0 && refused >= 40, strings.Join(problems, "; "))
	after := v.send(call{as: who, method: http.MethodGet, path: path + "/" + v.marker})
	v.that("the record did not change", text(before, "Texto") == text(after, "Texto") && text(after, "Texto") != "", text(after, "Texto"))
	hidden := "VERIFY-RESTRICTED-" + v.run
	if _, err := v.must("a restricted record is created", call{
		as: v.analyst, method: http.MethodPost, path: path,
		json: map[string]any{"payload": map[string]any{"ID_Compromiso": hidden, "Texto": "synthetic restricted"}},
	}); err != nil {
		return err
	}
	if _, err := v.must("it is marked restricted", call{
		as: v.analyst, method: http.MethodPut, path: "/system/marking",
		json: map[string]any{"module": verifyModule, "id": hidden, "marking": "restringido"},
	}); err != nil {
		return err
	}
	v.want("an analyst still reads it", http.StatusOK, call{as: v.analyst, method: http.MethodGet, path: path + "/" + hidden})
	v.want("the read-only role does not", http.StatusNotFound, call{as: who, method: http.MethodGet, path: path + "/" + hidden})
	return nil
}

// sweep calls every route of the inventory once. Nobody gets in without their credential, and no
// read breaks; a route that cannot be reached is a route the CLI does not really cover.
func (v *verifier) sweep() error {
	var open, broken []string
	reads, reached := 0, 0
	for _, route := range v.app.routes {
		answer := v.send(call{method: route.Method, path: v.placeholderPath(route)})
		if answer.status != 0 {
			reached++
		}
		switch {
		case answer.status >= 500:
			broken = append(broken, fmt.Sprintf("anonymous %s answered %d", route.Key(), answer.status))
		case route.Access == AccessSession && answer.status != http.StatusUnauthorized,
			route.Access == AccessMachine && answer.status < 400:
			open = append(open, fmt.Sprintf("%s answered %d", route.Key(), answer.status))
		}
		if route.Method != http.MethodGet || route.Access != AccessSession {
			continue
		}
		reads++
		if answer = v.send(call{as: v.admin, method: http.MethodGet, path: v.placeholderPath(route)}); answer.status >= 500 || answer.status == 0 {
			broken = append(broken, fmt.Sprintf("%s answered %d", route.Key(), answer.status))
		}
	}
	v.that(fmt.Sprintf("every route of the inventory answers (%d)", reached), reached == len(v.app.routes), fmt.Sprintf("%d of %d", reached, len(v.app.routes)))
	v.that("nothing opens without its credential", len(open) == 0, strings.Join(open, "; "))
	v.that(fmt.Sprintf("no read answers a server error (%d routes)", reads), len(broken) == 0, strings.Join(broken, "; "))
	return nil
}

func (v *verifier) cleanup() error {
	for _, username := range v.created {
		answer := v.send(call{as: v.admin, method: http.MethodPost, path: "/system/auth/accounts/" + username + "/deactivate"})
		v.that("account "+username+" is deactivated", answer.status == http.StatusOK, fmt.Sprintf("%d %s", answer.status, shortDetail(answer)))
	}
	if v.viewer != nil && v.viewer.secret != "" {
		code, err := totpCode(v.viewer.secret, v.app.step()+1)
		if err != nil {
			return err
		}
		v.want("a deactivated account cannot sign in", http.StatusUnauthorized, call{
			method: http.MethodPost, path: "/login", contentType: "application/x-www-form-urlencoded",
			form: loginForm(v.viewer.username, v.viewer.password, code),
		})
	}
	return nil
}
