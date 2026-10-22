#include <iostream>
#include <string>
#include <iomanip>
using namespace std;

int main() {
    int a, b;
    cin >> a >> b;
    double d;
    cin >> d;
    string name;
    cin >> name;
    cout << a + b << " " << a / b << " " << a % b << endl;
    cout << fixed << setprecision(2) << d * 2 << endl;
    cout << "Hi, " << name << "!" << endl;
    bool big = a > 5 && !(b == 0);
    cout << big << endl;
    char c = 'A';
    c += 2;
    cout << c << endl;
    int digit = '7' - '0';
    cout << digit << endl;
    return 0;
}
